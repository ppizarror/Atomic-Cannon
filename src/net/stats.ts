/**
 * Global play stats — a tiny anonymous, aggregate telemetry pipeline shared by the client and the
 * Cloudflare worker. The playing client POSTs a delta as each BATTLE ends (and one closing the war);
 * the worker stamps it with the visitor's edge country (`request.cf.country`) and folds it into a
 * single global `Stats` Durable Object. The About screen GETs the aggregate for the counters + map.
 *
 * Two tiers, matching what the game itself shows: a WAR is the whole story (the fireworks / final
 * standings), a BATTLE is one map inside it — Deathmatch plays `Settings → Battles` of them, while
 * Rounds/Points is a single battle. Nothing finer is uploaded: a per-round POST is needless traffic.
 *
 * Uploads are incremental and NEVER click-gated — each battle is banked the moment it ends. One lump
 * at the end of the war, gated on the player CLICKING past the final standings, throws the whole
 * match away when they quit to the menu, close the tab, or just walk away from the victory screen.
 *
 * It is deliberately approximate: a public, unauthenticated counter (no accounts), server-capped per
 * request so one client can't wildly inflate it. No IPs or personal data are stored — only per-country
 * war COUNTS (the country never leaves the edge as anything but a 2-letter code).
 */
import {clamp} from '../math/num';

/** The cumulative counters shown on the About "stats" panel. */
export interface StatsTotals {
  wars: number; // wars finished (every battle played out — the fireworks screen)
  onlineWars: number; // subset of `wars` that were network matches
  battles: number; // battles finished (a war is 1..N battles)
  weaponsFired: number; // fire actions (one trigger pull, regardless of salvo size)
  shotsFired: number; // individual projectiles/rounds launched
  tanksDestroyed: number; // tank kills
  damageDealt: number; // total life removed across all hits
  nukesFired: number; // super-weapon (nuke-class) fires
  terrainCarved: number; // ground-carving blasts
  creditsSpent: number; // credits spent in the depot
  playTimeSec: number; // total time played (summed war durations)
  longestWarSec: number; // longest single war
}

/** The full aggregate the server returns (`GET /api/stats`). */
export interface StatsSnapshot {
  totals: StatsTotals;
  /** ISO-3166-1 alpha-2 country code → wars finished from there. */
  countries: Record<string, number>;
  updated: number; // epoch ms of the last write (0 if never)
}

/**
 * The per-match play counters — the ONE list that drives the running tally, the upload delta and
 * the caps. The client accumulates each during a match and uploads the difference since the last
 * flush; the names are identical on both sides so nothing has to be mapped.
 *
 * Adding a counter here is the whole change: the tally type, the zeroing, the differencing and the
 * delta all derive from it, so there is no second place to forget — a missed one would be a stat
 * that silently never uploads.
 */
export const MATCH_COUNTERS = [
  'weaponsFired', // fire actions (one trigger pull, regardless of salvo size)
  'shotsFired', // individual projectiles/rounds launched
  'tanksDestroyed', // tank kills
  'damageDealt', // total life removed across all hits
  'nukesFired', // super-weapon (nuke-class) fires
  'terrainCarved', // ground-carving blasts
  'creditsSpent', // credits spent in the depot
] as const;

export type MatchCounter = (typeof MATCH_COUNTERS)[number];

/** One incremental upload: everything played since the previous upload, plus the units of progress
 *  this flush closes (`wars` is 0/1 — a war only ends once). Every number is client-sent, so the
 *  server re-clamps all of them (see STAT_CAPS) instead of trusting any. */
export interface StatsDelta extends Record<MatchCounter, number> {
  wars: number; // 1 when this flush closes the war, else 0
  battles: number; // battles completed by this flush
  /** Seconds played since the previous flush → folded into playTimeSec. */
  playSec: number;
  /** The whole war's duration — sent ONLY on the war-closing flush (0 otherwise) → longestWarSec.
   *  Kept separate from `playSec` so a mid-war flush can't make "longest war" mean "longest battle". */
  warSec: number;
  /** Was this a network match? The server bumps onlineWars when true (by `wars`). */
  online: boolean;
}

/** The numeric (capped) fields of a delta — everything except the `online` flag. */
export type StatsDeltaNums = Omit<StatsDelta, 'online'>;

/** Server-side per-request caps so a single POST can't wildly inflate a counter. Sized for ONE
 *  flush of a long battle. Shared so client and worker agree; the worker is the enforcer. */
export const STAT_CAPS: Record<keyof StatsDeltaNums, number> = {
  wars: 1, // a flush closes at most one war
  battles: 64, // Settings → Battles is far below this
  weaponsFired: 5_000,
  shotsFired: 20_000,
  tanksDestroyed: 128,
  damageDealt: 20_000_000,
  nukesFired: 2_000,
  terrainCarved: 20_000,
  creditsSpent: 20_000_000,
  playSec: 86_400, // a day — longer than any real single match
  warSec: 86_400,
};

export const EMPTY_TOTALS: StatsTotals = {
  wars: 0,
  onlineWars: 0,
  battles: 0,
  weaponsFired: 0,
  shotsFired: 0,
  tanksDestroyed: 0,
  damageDealt: 0,
  nukesFired: 0,
  terrainCarved: 0,
  creditsSpent: 0,
  playTimeSec: 0,
  longestWarSec: 0,
};

/** A zero delta — the starting point for the client's pending-upload accumulator. */
export const emptyDelta = (): StatsDelta => {
  const d = {online: false} as StatsDelta;
  for (const k of Object.keys(STAT_CAPS) as (keyof StatsDeltaNums)[]) d[k] = 0;
  return d;
};

/** True when a delta carries nothing worth a request (no play, no progress). */
export const isEmptyDelta = (d: StatsDelta): boolean =>
  (Object.keys(STAT_CAPS) as (keyof StatsDeltaNums)[]).every(k => d[k] <= 0);

/** Fold `b` into `a` (both left untouched) — used to re-queue a flush whose upload failed, so an
 *  offline moment costs nothing: the next flush carries both. Durations sum, except `warSec`
 *  which is a max (it's a "longest", not a total). */
export function mergeDelta(a: StatsDelta, b: StatsDelta): StatsDelta {
  const out = {online: a.online || b.online} as StatsDelta;
  for (const k of Object.keys(STAT_CAPS) as (keyof StatsDeltaNums)[]) out[k] = a[k] + b[k];
  out.warSec = Math.max(a.warSec, b.warSec);
  return out;
}

/** Clamp a delta to non-negative, finite, capped integers — used by BOTH sides (client trims before
 *  sending; server re-enforces on receipt, never trusting the client). */
export function sanitizeDelta(raw: Partial<StatsDelta>): StatsDelta {
  const clean = {online: !!raw.online} as StatsDelta;
  for (const k of Object.keys(STAT_CAPS) as (keyof StatsDeltaNums)[]) {
    const n = Math.floor(Number(raw[k]));
    clean[k] = Number.isFinite(n) ? clamp(n, 0, STAT_CAPS[k]) : 0;
  }
  return clean;
}

/** POST one incremental delta. Fire-and-forget for the caller (never throws, never blocks gameplay),
 *  but it reports success so the client can re-queue a delta the network dropped. */
export async function postStatsDelta(delta: StatsDelta): Promise<boolean> {
  try {
    const r = await fetch('/api/stats', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(sanitizeDelta(delta)),
      keepalive: true, // still sends if the page is navigating away
    });
    return r.ok;
  } catch {
    return false; // telemetry is best-effort — a failed upload must never affect the game
  }
}

/** Fetch the global aggregate for the About screen. Returns null on any failure (offline/error). */
export async function fetchStats(): Promise<StatsSnapshot | null> {
  try {
    const r = await fetch('/api/stats', {headers: {accept: 'application/json'}});
    if (!r.ok) return null;
    return (await r.json()) as StatsSnapshot;
  } catch {
    return null;
  }
}
