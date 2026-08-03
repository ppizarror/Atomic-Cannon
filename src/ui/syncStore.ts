/**
 * Profile sync — the client half of the cloud save. Holds this device's link to a profile
 * (its id and the revision it last agreed with the server on), pulls at launch, and pushes
 * automatically whenever anything persisted changes.
 *
 * ## Why pulling happens at BOOT, before anything else
 *
 * Every store seeds its signal from localStorage at module-import time. `bootSync` therefore runs
 * from `main.tsx` BEFORE the app module is imported, so a pulled profile is already in storage by
 * the time the stores read it. Pulling any later would mean rewriting storage underneath signals
 * that had already seeded — which only takes effect after a `location.reload()`, i.e. a visible
 * flash on every launch where another device was ahead.
 *
 * ## How two devices are kept from overwriting each other
 *
 * Uploads are compare-and-swap (see `net/profile.ts`): each carries the revision it was based on,
 * and the server refuses it if the stored revision has moved on. The loser of that race does NOT
 * retry with a higher revision — that would be precisely the blind overwrite the CAS exists to
 * prevent. It marks itself `stale`, stops auto-uploading, and adopts the cloud copy at the next
 * launch. Conflicts resolve CLOUD-WINS: the price is that changes made on a device that fell
 * behind are dropped, which is why `stale` is surfaced in the Sync screen rather than hidden.
 *
 * Nothing here throws or blocks the game: sync is a convenience, so every failure path leaves the
 * device playing happily on its local data.
 */
import {signal} from '@preact/signals';
import {createPersistedSignal} from './persistedSignal';
import {onStorageWrite} from '../util/storage';
import {exportSettings, applyBackup, isPayloadKey, SYNC_KEY} from '../util/settingsBackup';
import {createProfile, fetchProfile, pushProfile, PROFILE_BOOT_TIMEOUT_MS} from '../net/profile';
import type {CallOpts, ProfilePayload, PushResult} from '../net/profile';
import {normalizeProfileCode, isValidProfileCode} from '../net/profileCode';
import type {SyncOutcome} from './syncOutcome';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** This device's relationship to a cloud profile. Persisted, but deliberately NOT part of the
 *  synced payload — see `LOCAL_ONLY_KEYS` in settingsBackup. */
export interface SyncLink {
  /** The profile id, or '' when this device isn't linked to one. */
  code: string;
  /** Revision this device last read from / wrote to the server — the compare-and-swap token. */
  rev: number;
  /** Local changes the server hasn't accepted yet. */
  dirty: boolean;
  /** Epoch ms of the last successful push or pull (device clock — display only). */
  lastSync: number;
  /** Lost a compare-and-swap: another device wrote while this one held `rev`. Auto-upload stops
   *  until the next launch, which adopts the cloud copy. */
  stale: boolean;
}

export type {SyncOutcome};

// ==========================================================================
// TUNING
// ==========================================================================

/** Quiet period after a change before uploading. Long enough that a burst of writes (a battle
 *  ending: high scores, stats and setup all land together) becomes ONE request, short enough
 *  that closing the tab a few seconds later still finds the data already sent. */
const PUSH_DEBOUNCE_MS = 5_000;

// ==========================================================================
// STATE
// ==========================================================================

const NO_LINK: SyncLink = {code: '', rev: 0, dirty: false, lastSync: 0, stale: false};

/** Coerce a stored blob into a usable link — a corrupt or half-written record reads as "not
 *  linked" rather than as a link with a nonsense revision, which would fail every CAS forever. */
function reviveLink(raw: unknown): SyncLink {
  const r = (raw ?? {}) as Partial<SyncLink>;
  const code = typeof r.code === 'string' ? normalizeProfileCode(r.code) : '';
  if (!isValidProfileCode(code)) return NO_LINK;
  const rev = Number(r.rev);
  return {
    code,
    rev: Number.isFinite(rev) && rev > 0 ? Math.floor(rev) : 0,
    dirty: !!r.dirty,
    lastSync: Number.isFinite(Number(r.lastSync)) ? Number(r.lastSync) : 0,
    stale: !!r.stale,
  };
}

const store = createPersistedSignal<SyncLink>(SYNC_KEY, {seed: () => NO_LINK, revive: reviveLink});

/** The live link. Read in the Sync screen; mutated only through the actions below. */
export const syncLink = store.signal;

/** A sync request is in flight (drives the screen's busy state). */
export const syncBusy = signal(false);

/** Result of the most recent action, for the status line. Cleared when the screen re-arms. */
export const syncOutcome = signal<SyncOutcome | null>(null);

/** Monotonic count of payload changes seen. Captured around a push so changes made WHILE the
 *  request was in flight aren't wrongly marked as delivered by its success. */
let changeSeq = 0;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
/** In-flight push, so overlapping triggers coalesce instead of racing each other's CAS. */
let pushing: Promise<PushResult | null> | null = null;
let listening = false;

const now = (): number => Date.now();
const setLink = (next: SyncLink): void => store.set(next);

/** Map a transport failure to the outcome the status line shows. */
const failOutcome = (reason: string): SyncOutcome =>
  reason === 'too-large'
    ? 'tooLarge'
    : reason === 'rate-limited'
      ? 'rateLimited'
      : reason === 'missing'
        ? 'missing'
        : 'offline';

// ==========================================================================
// PUSH
// ==========================================================================

/** This device's current state, in the exact shape the cloud stores (identical to a backup file). */
const snapshot = (): ProfilePayload => exportSettings();

function cancelPending(): void {
  if (pushTimer !== undefined) clearTimeout(pushTimer);
  pushTimer = undefined;
}

function schedulePush(): void {
  cancelPending();
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    void doPush();
  }, PUSH_DEBOUNCE_MS);
}

/**
 * Upload the current state under the revision this device holds. Returns null when there is
 * nothing to do (not linked, or already known to be behind).
 */
async function doPush(opts: CallOpts = {}): Promise<PushResult | null> {
  const link = syncLink.value;
  if (!link.code || link.stale) return null;
  if (pushing) return pushing; // one at a time — a second CAS from the same device would lose
  const seq = changeSeq;
  const data = snapshot();
  pushing = (async (): Promise<PushResult | null> => {
    const res = await pushProfile(link.code, link.rev, data, opts);
    const cur = syncLink.value;
    if (res.ok) {
      // Anything written while the request was in flight is still unsent, so it keeps the
      // device dirty and earns another round rather than being silently marked delivered.
      const changedMidFlight = changeSeq !== seq;
      setLink({...cur, rev: res.rev, dirty: changedMidFlight, stale: false, lastSync: now()});
      if (changedMidFlight) schedulePush();
    } else if (res.reason === 'conflict') {
      // Another device wrote first. Do NOT re-push against the newer revision — back off and let
      // the next launch take the cloud copy.
      setLink({...cur, stale: true});
      syncOutcome.value = 'conflict';
    } else {
      // Offline / throttled / oversized: stay dirty so the next change or the exit flush retries.
      syncOutcome.value = failOutcome(res.reason);
    }
    return res;
  })();
  try {
    return await pushing;
  } finally {
    pushing = null;
  }
}

// ==========================================================================
// PULL
// ==========================================================================

/** Fetch `code` and overwrite this device with it. The caller reloads on success, because the
 *  stores seeded from the storage this just rewrote. */
async function pullInto(code: string, okOutcome: SyncOutcome): Promise<boolean> {
  const res = await fetchProfile(code);
  if (!res.ok) {
    syncOutcome.value = failOutcome(res.reason);
    return false;
  }
  if (applyBackup(res.record.data) < 0) {
    syncOutcome.value = 'badData'; // stored blob isn't one of our backups — leave this device alone
    return false;
  }
  cancelPending(); // the local state we were about to upload no longer exists
  setLink({code, rev: res.record.rev, dirty: false, stale: false, lastSync: now()});
  syncOutcome.value = okOutcome;
  return true;
}

// ==========================================================================
// BOOT
// ==========================================================================

/**
 * Resolve this device against the cloud, before any store seeds. Four cases:
 *
 * | dirty | cloud revision | what happens                                   |
 * |-------|----------------|------------------------------------------------|
 * | no    | same           | nothing                                        |
 * | no    | ahead          | adopt the cloud copy                           |
 * | yes   | same           | publish this device's offline changes          |
 * | yes   | ahead          | cloud wins — adopt it; local changes are lost  |
 *
 * Unreachable server (offline, timeout, a deleted profile) is not an error: the game starts on
 * whatever this device already has.
 */
export async function bootSync(): Promise<void> {
  const link = syncLink.value;
  if (!link.code) return;
  const res = await fetchProfile(link.code, {timeoutMs: PROFILE_BOOT_TIMEOUT_MS});
  if (!res.ok) return;
  const rec = res.record;
  if (rec.rev !== link.rev) {
    // The cloud moved on (another device wrote, or this one previously lost a CAS). Cloud wins.
    if (applyBackup(rec.data) >= 0) {
      setLink({code: link.code, rev: rec.rev, dirty: false, stale: false, lastSync: now()});
    }
    return;
  }
  // Same revision: nobody else wrote, so anything this device changed offline is safe to publish.
  if (link.dirty) await doPush();
}

/**
 * Start watching for changes. Called from the app once boot resolution is done — installing it
 * earlier would see `bootSync`'s own writes as player edits and immediately re-upload what was
 * just downloaded.
 */
export function initProfileSync(): void {
  if (listening) return;
  listening = true;

  onStorageWrite(key => {
    if (!isPayloadKey(key)) return; // the sync link itself, and device-local keys, aren't changes
    if (!syncLink.value.code) return; // not linked — nothing to upload to
    changeSeq++;
    const link = syncLink.value;
    if (!link.dirty) setLink({...link, dirty: true});
    if (!link.stale) schedulePush();
  });

  // Leaving the page: send what's pending now rather than losing the debounce window. `keepalive`
  // lets the request outlive the document. `pagehide` covers tab close/navigation; the hidden
  // branch of `visibilitychange` covers the mobile case where a backgrounded tab is killed
  // outright and `pagehide` never arrives.
  const flush = (): void => {
    const link = syncLink.value;
    if (!link.code || !link.dirty || link.stale) return;
    cancelPending();
    void doPush({keepalive: true});
  };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
  });
}

// ==========================================================================
// ACTIONS
// ==========================================================================

/** Mint a new profile from this device's data and link to it. */
export async function createProfileNow(): Promise<boolean> {
  if (syncBusy.value) return false;
  syncBusy.value = true;
  try {
    const res = await createProfile(snapshot());
    if (!res.ok) {
      syncOutcome.value = failOutcome(res.reason);
      return false;
    }
    cancelPending();
    setLink({code: res.code, rev: res.rev, dirty: false, stale: false, lastSync: now()});
    syncOutcome.value = 'created';
    return true;
  } finally {
    syncBusy.value = false;
  }
}

/** Link this device to an existing profile, REPLACING everything stored locally with it.
 *  Returns true when the caller should reload. */
export async function linkProfile(input: string): Promise<boolean> {
  if (syncBusy.value) return false;
  const code = normalizeProfileCode(input);
  if (!isValidProfileCode(code)) {
    syncOutcome.value = 'badCode';
    return false;
  }
  syncBusy.value = true;
  try {
    return await pullInto(code, 'linked');
  } finally {
    syncBusy.value = false;
  }
}

/** Re-download the linked profile on demand. Returns true when the caller should reload. */
export async function downloadNow(): Promise<boolean> {
  const link = syncLink.value;
  if (!link.code || syncBusy.value) return false;
  syncBusy.value = true;
  try {
    return await pullInto(link.code, 'downloaded');
  } finally {
    syncBusy.value = false;
  }
}

/** Push now instead of waiting out the debounce. Still a compare-and-swap: a device that has
 *  fallen behind is told to download rather than being allowed to overwrite the newer copy. */
export async function uploadNow(): Promise<void> {
  const link = syncLink.value;
  if (!link.code || syncBusy.value) return;
  if (link.stale) {
    syncOutcome.value = 'conflict';
    return;
  }
  if (!link.dirty) {
    syncOutcome.value = 'upToDate';
    return;
  }
  syncBusy.value = true;
  try {
    cancelPending();
    const res = await doPush();
    if (res?.ok) syncOutcome.value = 'uploaded';
  } finally {
    syncBusy.value = false;
  }
}

/** Unlink this device. The cloud copy is left untouched — the id can be linked again, here or
 *  anywhere else. Local settings and scores stay exactly as they are; only the link is dropped. */
export function desync(): void {
  cancelPending();
  setLink(NO_LINK);
  syncOutcome.value = null;
}

/** Drop the status line (called when the screen opens, so a stale message doesn't greet you). */
export function clearSyncOutcome(): void {
  syncOutcome.value = null;
}
