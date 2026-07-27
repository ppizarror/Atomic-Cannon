/**
 * Stats — ONE global Durable Object (named "global") that holds the aggregate play counters and the
 * per-country war tally shown on the About screen. A single DO gives atomic read-modify-write, so
 * concurrent battle-end POSTs never lose an increment (unlike KV). No IPs / personal data are
 * stored — only summed counters and a 2-letter country → wars map.
 *
 * The front-door worker forwards `POST /api/stats` here (stamped with the edge country) and serves
 * `GET /api/stats` from here. Clients upload INCREMENTALLY (as each battle ends, and once more when
 * the war does), so every number arrives from the client and every one is re-clamped server-side
 * (never trust the client) — the worst a bad actor can do is add a few wars at the per-IP rate
 * limit, approximate-by-design like any public unauthenticated counter.
 */
import {
  type StatsSnapshot,
  type StatsTotals,
  type StatsDelta,
  type StatsDeltaNums,
  EMPTY_TOTALS,
  sanitizeDelta,
} from '../src/net/stats';

interface Env {
  STATS: DurableObjectNamespace;
}

/** Delta fields that simply add into the same-named total. The two durations are the exception:
 *  `playSec` accumulates into playTimeSec and `warSec` maxes into longestWarSec. */
const SUM_FIELDS: Exclude<keyof StatsDeltaNums, 'playSec' | 'warSec' | 'wars'>[] = [
  'battles',
  'weaponsFired',
  'shotsFired',
  'tanksDestroyed',
  'damageDealt',
  'nukesFired',
  'terrainCarved',
  'creditsSpent',
];

const freshSnapshot = (): StatsSnapshot => ({
  totals: {...EMPTY_TOTALS},
  countries: {},
  updated: 0,
});

/** A well-formed ISO-3166-1 alpha-2 code, else 'XX' (unknown/edge couldn't resolve). */
const normCountry = (c: string | null | undefined): string =>
  typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : 'XX';

export class Stats {
  constructor(private readonly ctx: DurableObjectState) {}

  /** The stored aggregate, normalised against EMPTY_TOTALS: a counter the stored blob predates
   *  (or one holding garbage) reads as 0 rather than undefined, and a counter it still carries from
   *  an older shape is dropped. Arithmetic on the result is always finite. */
  private async load(): Promise<StatsSnapshot> {
    const raw = await this.ctx.storage.get<Partial<StatsSnapshot>>('stats');
    if (!raw) return freshSnapshot();
    const stored = (raw.totals ?? {}) as Record<string, unknown>;
    const totals = {...EMPTY_TOTALS};
    for (const k of Object.keys(EMPTY_TOTALS) as (keyof StatsTotals)[]) {
      const n = Number(stored[k]);
      if (Number.isFinite(n) && n > 0) totals[k] = n;
    }
    return {totals, countries: {...raw.countries}, updated: raw.updated ?? 0};
  }

  async fetch(req: Request): Promise<Response> {
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});

    if (req.method === 'GET') {
      return json(await this.load());
    }
    if (req.method !== 'POST') return json({error: 'method not allowed'}, 405);

    let body: {delta?: Partial<StatsDelta>; country?: string};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({error: 'bad body'}, 400);
    }
    // Re-clamp server-side: never trust the client's numbers.
    const delta = sanitizeDelta(body.delta ?? {});
    const country = normCountry(body.country);

    // Serialize the read-modify-write so concurrent POSTs can't clobber each other.
    await this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.load();
      const t = s.totals;
      // `wars` (and the country tally, and onlineWars) only move on the flush that CLOSES a war —
      // the per-battle flushes that precede it carry wars:0 and just add play.
      t.wars += delta.wars;
      if (delta.online) t.onlineWars += delta.wars;
      for (const f of SUM_FIELDS) t[f] += delta[f];
      t.playTimeSec += delta.playSec;
      t.longestWarSec = Math.max(t.longestWarSec, delta.warSec);
      if (delta.wars > 0) s.countries[country] = (s.countries[country] ?? 0) + delta.wars;
      s.updated = Date.now();
      await this.ctx.storage.put('stats', s);
    });

    return json({ok: true});
  }
}

export type {Env as StatsEnv};
