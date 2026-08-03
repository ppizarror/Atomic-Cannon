/**
 * Profile sync protocol — the contract between the browser client and the `Profile` Durable
 * Object that stores one player's settings/scores under a 12-char id. Shared by both sides so
 * the revision rules can't drift apart.
 *
 * THE ONE IMPORTANT RULE: every write is a compare-and-swap. The client sends the `rev` it last
 * saw and the server refuses the write (409) if the stored rev has moved on. Without it, two
 * devices that both auto-upload silently overwrite each other — a phone that banks a high score
 * loses it the moment a desktop, holding a stale snapshot, flushes ten seconds later. With it,
 * a concurrent write is *detected*, and the loser backs off and re-reads instead of clobbering.
 *
 * Conflicts are resolved cloud-wins (see `syncStore`): a device that loses the CAS stops
 * auto-uploading and adopts the cloud copy on its next launch.
 *
 * Isomorphic: no DOM, no Node, no Workers API beyond `fetch` (which both runtimes have).
 */

/** Hard cap on one profile's serialized payload. A real save (settings + controls + players +
 *  taunts + high scores) is a few KB; this is generous enough to never bite a real player while
 *  keeping a single Durable Object from being used as free blob storage — and it stays clear of
 *  the per-value ceiling on DO storage, so a legitimate save can never fail to write. */
export const PROFILE_MAX_BYTES = 64 * 1024;

/** How long the boot pull may block startup before the game gives up and plays on local data.
 *  Sync is a convenience — it must never be the reason the game won't start. */
export const PROFILE_BOOT_TIMEOUT_MS = 2500;

/**
 * What a profile stores: whatever `settingsBackup.exportSettings()` produced — the SAME object a
 * backup file contains, format marker and all. The server treats it as opaque JSON (it validates
 * only shape and size); the client validates the marker on the way back in, so a cloud save and a
 * backup file are interchangeable and there is no second format to keep in step.
 */
export type ProfilePayload = Record<string, unknown>;

/** A stored profile, as the DO holds it and `GET` returns it. */
export interface ProfileRecord {
  /** Bumped on every accepted write — the compare-and-swap token, not a timestamp, so it is
   *  immune to the device clock skew that would make "newest wins" unreliable across devices. */
  rev: number;
  /** Epoch ms of that write (server clock). Display only — never used to order writes. */
  updated: number;
  data: ProfilePayload;
}

/** Everything a write can produce. `conflict` carries the server's current rev so the caller
 *  knows what it lost to; `missing` means the id has no profile (a typo, or one never created). */
export type PushResult =
  | {ok: true; rev: number; updated: number}
  | {ok: false; reason: 'conflict'; rev: number}
  | {ok: false; reason: 'missing' | 'too-large' | 'rate-limited' | 'network'};

/** Result of a read. `missing` (that id holds nothing — a typo) is kept distinct from `network`
 *  (we couldn't ask) because they mean opposite things to a player linking a device: one is
 *  "check the code", the other is "try again in a minute". */
export type FetchResult =
  {ok: true; record: ProfileRecord} | {ok: false; reason: 'missing' | 'rate-limited' | 'network'};

/** Result of minting a brand-new profile from this device's data. */
export type CreateResult =
  | {ok: true; code: string; rev: number; updated: number}
  | {ok: false; reason: 'too-large' | 'rate-limited' | 'network'};

/** Per-call knobs shared by the write helpers. */
export interface CallOpts {
  timeoutMs?: number;
  /** Let the request outlive the page (the flush on tab close). */
  keepalive?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// ==========================================================================
// VALIDATION
// ==========================================================================

/** Serialized size of a payload in bytes (UTF-8), for the cap check on both sides. */
export function payloadBytes(data: ProfilePayload): number {
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

/** True iff `v` is a plain JSON object we're willing to store as a payload. Rejects arrays and
 *  null, both of which are `typeof 'object'` and would round-trip into garbage on restore. */
export function isPayload(v: unknown): v is ProfilePayload {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ==========================================================================
// CLIENT
// ==========================================================================

/** `fetch` with a bounded deadline. Every sync call is best-effort — a hung request must not
 *  wedge the boot or leave the Sync screen spinning forever. */
async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: ctrl.signal});
  } finally {
    clearTimeout(timer);
  }
}

const JSON_HEADERS = {'content-type': 'application/json'};

/** Mint a new profile from this device's data. The server picks the id (and re-rolls on the
 *  vanishingly unlikely collision), so a client can never claim an id already in use. */
export async function createProfile(data: ProfilePayload, opts: CallOpts = {}): Promise<CreateResult> {
  if (payloadBytes(data) > PROFILE_MAX_BYTES) return {ok: false, reason: 'too-large'};
  try {
    const r = await timedFetch(
      '/api/profile',
      {method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({data})},
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (r.status === 429) return {ok: false, reason: 'rate-limited'};
    if (r.status === 413) return {ok: false, reason: 'too-large'};
    if (!r.ok) return {ok: false, reason: 'network'};
    const body = (await r.json()) as {code?: string; rev?: number; updated?: number};
    if (!body.code) return {ok: false, reason: 'network'};
    return {ok: true, code: body.code, rev: body.rev ?? 1, updated: body.updated ?? 0};
  } catch {
    return {ok: false, reason: 'network'};
  }
}

/** Read a profile. A malformed body is reported as `network`: the request technically succeeded,
 *  but the answer is unusable, and every caller must treat it the same way — keep the data
 *  already on this device. */
export async function fetchProfile(code: string, opts: CallOpts = {}): Promise<FetchResult> {
  try {
    const r = await timedFetch(
      `/api/profile/${code}`,
      {headers: {accept: 'application/json'}},
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (r.status === 404) return {ok: false, reason: 'missing'};
    if (r.status === 429) return {ok: false, reason: 'rate-limited'};
    if (!r.ok) return {ok: false, reason: 'network'};
    const body = (await r.json()) as Partial<ProfileRecord>;
    if (!isPayload(body.data) || typeof body.rev !== 'number') return {ok: false, reason: 'network'};
    return {ok: true, record: {rev: body.rev, updated: body.updated ?? 0, data: body.data}};
  } catch {
    return {ok: false, reason: 'network'};
  }
}

/** Push this device's data, guarded by the rev it was based on. A `conflict` result means
 *  another device wrote first — the caller must NOT retry with a bumped rev (that is exactly
 *  the silent clobber the CAS exists to prevent). */
export async function pushProfile(
  code: string,
  baseRev: number,
  data: ProfilePayload,
  opts: CallOpts = {},
): Promise<PushResult> {
  if (payloadBytes(data) > PROFILE_MAX_BYTES) return {ok: false, reason: 'too-large'};
  try {
    const r = await timedFetch(
      `/api/profile/${code}`,
      {method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({baseRev, data}), keepalive: opts.keepalive},
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (r.status === 409) {
      const body = (await r.json().catch(() => ({}))) as {rev?: number};
      return {ok: false, reason: 'conflict', rev: body.rev ?? baseRev};
    }
    if (r.status === 404) return {ok: false, reason: 'missing'};
    if (r.status === 413) return {ok: false, reason: 'too-large'};
    if (r.status === 429) return {ok: false, reason: 'rate-limited'};
    if (!r.ok) return {ok: false, reason: 'network'};
    const body = (await r.json()) as {rev?: number; updated?: number};
    return {ok: true, rev: body.rev ?? baseRev + 1, updated: body.updated ?? 0};
  } catch {
    return {ok: false, reason: 'network'};
  }
}
