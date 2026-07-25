/**
 * Global play stats — a tiny anonymous, aggregate telemetry pipeline shared by the client and the
 * Cloudflare worker. When a match finishes, one client POSTs a per-game delta to `/api/stats`; the
 * worker stamps it with the visitor's edge country (`request.cf.country`) and folds it into a single
 * global `Stats` Durable Object. The About screen GETs the aggregate to show the counters + world map.
 *
 * It is deliberately approximate: a public, unauthenticated counter (no accounts), server-capped per
 * request so one client can't wildly inflate it. No IPs or personal data are stored — only per-country
 * game COUNTS (the country never leaves the edge as anything but a 2-letter code).
 */

/** The cumulative counters shown on the About "stats" panel. */
export interface StatsTotals {
  games: number; // matches finished (solo + online)
  onlineGames: number; // subset of `games` that were network matches
  weaponsFired: number; // fire actions (one trigger pull, regardless of salvo size)
  shotsFired: number; // individual projectiles/rounds launched
  tanksDestroyed: number; // tank kills
  damageDealt: number; // total life removed across all hits
  nukesFired: number; // super-weapon (nuke-class) fires
  terrainCarved: number; // ground-carving blasts
  creditsSpent: number; // credits spent in the depot
  playTimeSec: number; // total time played (summed match durations)
  longestGameSec: number; // longest single match
}

/** The full aggregate the server returns (`GET /api/stats`). */
export interface StatsSnapshot {
  totals: StatsTotals;
  /** ISO-3166-1 alpha-2 country code → games finished from there. */
  countries: Record<string, number>;
  updated: number; // epoch ms of the last write (0 if never)
}

/** The per-match delta a finishing client sends. `games`/`onlineGames`/`longestGameSec` are NOT
 *  trusted numeric inputs — the server derives them (+1 game, +1 online iff `online`, max duration). */
export type StatsDelta = Omit<
  StatsTotals,
  'games' | 'onlineGames' | 'playTimeSec' | 'longestGameSec'
> & {
  /** This match's duration in seconds — the server folds it into playTimeSec AND longestGameSec. */
  gameSec: number;
  /** Was this a network match? The server bumps onlineGames when true. */
  online: boolean;
};

/** The numeric (capped) fields of a delta — everything except the `online` flag. */
export type StatsDeltaNums = Omit<StatsDelta, 'online'>;

/** Server-side per-request caps (one finished match) so a single POST can't wildly inflate a counter.
 *  Shared so client and worker agree; the worker is the enforcer. `games` is server-controlled (+1). */
export const STAT_CAPS: Record<keyof StatsDeltaNums, number> = {
  weaponsFired: 5_000,
  shotsFired: 20_000,
  tanksDestroyed: 128,
  damageDealt: 20_000_000,
  nukesFired: 2_000,
  terrainCarved: 20_000,
  creditsSpent: 20_000_000,
  gameSec: 86_400, // a day — longer than any real single match
};

export const EMPTY_TOTALS: StatsTotals = {
  games: 0,
  onlineGames: 0,
  weaponsFired: 0,
  shotsFired: 0,
  tanksDestroyed: 0,
  damageDealt: 0,
  nukesFired: 0,
  terrainCarved: 0,
  creditsSpent: 0,
  playTimeSec: 0,
  longestGameSec: 0,
};

/** Clamp a delta to non-negative, finite, capped integers — used by BOTH sides (client trims before
 *  sending; server re-enforces on receipt, never trusting the client). */
export function sanitizeDelta(raw: Partial<StatsDelta>): StatsDelta {
  const clean = {online: !!raw.online} as StatsDelta;
  for (const k of Object.keys(STAT_CAPS) as (keyof StatsDeltaNums)[]) {
    const n = Math.floor(Number(raw[k]));
    clean[k] = Number.isFinite(n) ? Math.min(STAT_CAPS[k], Math.max(0, n)) : 0;
  }
  return clean;
}

/** POST a finished match's stats. Fire-and-forget: never throws, never blocks gameplay. */
export async function postGameStats(delta: StatsDelta): Promise<void> {
  try {
    await fetch('/api/stats', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(sanitizeDelta(delta)),
      keepalive: true, // still sends if the page is navigating away
    });
  } catch {
    /* telemetry is best-effort — a failed upload must never affect the game */
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
