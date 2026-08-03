/**
 * Import / Export / Reset for every persisted game setting — and the same snapshot the cloud
 * profile sync uploads, so a backup file and a synced profile are byte-for-byte the same shape.
 *
 * Each store persists under an `atomic.` localStorage key (settings, controls, players,
 * taunts, content, setup, audio, locale, high scores, net name). Rather than couple to each
 * store, these helpers snapshot / restore / clear the whole `atomic.` namespace at the
 * storage layer — a new store is covered automatically as long as it keeps the prefix.
 *
 * Restoring REPLACES rather than merges: a key the backup doesn't carry is removed, so
 * "restore this backup" lands you in exactly the state the backup describes instead of that
 * state plus whatever leftovers the device happened to have.
 *
 * Import and Reset rewrite storage underneath the running signals (which seeded at load), so
 * the caller reloads the page afterwards to re-seed every store from the new storage.
 */
import {loadJSON, saveJSON, removeKey} from './storage';

const PREFIX = 'atomic.';
/** Marker so Import can reject arbitrary JSON files that aren't our backups. */
const FORMAT = 'atomic-cannon-settings';

/** The profile-sync link (id + revision). Lives in the `atomic.` namespace but is NOT part of
 *  the payload — see {@link LOCAL_ONLY_KEYS}. Owned by `ui/syncStore`; declared here because
 *  this module is what has to leave it out, and importing it the other way would be a cycle. */
export const SYNC_KEY = 'atomic.sync';

/**
 * Keys inside the `atomic.` namespace deliberately excluded from a backup and from a synced
 * profile: they describe this DEVICE's relationship to a save, not the save itself.
 *
 * `atomic.sync` is load-bearing. If a profile carried the sync link, restoring it on a second
 * device would silently adopt the first device's id and revision — both devices would then push
 * as though they were one, and the compare-and-swap that stops them overwriting each other would
 * be comparing against a revision the second device never actually read.
 */
export const LOCAL_ONLY_KEYS: readonly string[] = [
  SYNC_KEY,
  'atomic.installDismissed', // per-device UI state: a new device should still get the install hint
];

/** A type alias rather than an interface on purpose: only aliases get the implicit index
 *  signature that lets a backup be passed straight to the sync layer as a JSON payload. */
export type SettingsBackup = {
  format: string;
  version: number;
  /** One entry per synced `atomic.` key → its parsed JSON value. */
  data: Record<string, unknown>;
};

/** Every `atomic.` key currently in localStorage. [] if storage is unavailable. */
function atomicKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    /* storage unavailable (private mode) */
  }
  return keys;
}

/** True for a key that belongs in a backup / profile (an `atomic.` key that isn't device-local). */
export const isPayloadKey = (key: string): boolean => key.startsWith(PREFIX) && !LOCAL_ONLY_KEYS.includes(key);

/** Snapshot every synced `atomic.` key into a portable backup object. This is exactly what the
 *  cloud profile stores, so the file format and the wire format never diverge. */
export function exportSettings(): SettingsBackup {
  const data: Record<string, unknown> = {};
  // Values always round-trip as JSON (all stores write via saveJSON); loadJSON yields null
  // for a value that's somehow corrupt, which serializes back harmlessly.
  for (const key of atomicKeys()) if (isPayloadKey(key)) data[key] = loadJSON<unknown>(key, null);
  return {format: FORMAT, version: 1, data};
}

/** True iff `v` looks like one of our backups (and not some other JSON that happens to parse). */
function isSettingsBackup(v: unknown): v is SettingsBackup {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<SettingsBackup>;
  return b.format === FORMAT && !!b.data && typeof b.data === 'object' && !Array.isArray(b.data);
}

/**
 * Restore a backup object (from a file or from the cloud), REPLACING the current namespace.
 * Returns the number of keys written, or -1 if it isn't a valid backup.
 *
 * Device-local keys (the sync link) are left strictly alone in both directions: never read from
 * the backup, never removed from the device. Caller should reload to re-seed the stores.
 */
export function applyBackup(backup: unknown): number {
  if (!isSettingsBackup(backup)) return -1;
  const incoming = backup.data;
  // Replace, don't merge: drop any payload key this backup doesn't carry.
  for (const key of atomicKeys()) {
    if (isPayloadKey(key) && !Object.prototype.hasOwnProperty.call(incoming, key)) removeKey(key);
  }
  let count = 0;
  for (const [key, val] of Object.entries(incoming)) {
    if (!isPayloadKey(key)) continue; // ignore foreign / device-local keys defensively
    saveJSON(key, val);
    count++;
  }
  return count;
}

/** Restore a backup produced by {@link exportSettings} from its JSON text. Returns the number of
 *  keys written, or -1 if the text isn't a valid backup. */
export function importSettings(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return -1;
  }
  return applyBackup(parsed);
}

/** Remove every `atomic.` key — a clean-slate reset. This DOES include the sync link: a reset is
 *  "as if the game had never been played", which means this device is no longer tied to a
 *  profile. (The cloud copy is untouched and can be linked again with its id.)
 *  Caller should reload afterwards. */
export function resetAllSettings(): void {
  for (const key of atomicKeys()) removeKey(key);
}
