/**
 * Stats — ONE global Durable Object (named "global") that holds the aggregate play counters and the
 * per-country game tally shown on the About screen. A single DO gives atomic read-modify-write, so
 * concurrent match-finish POSTs never lose an increment (unlike KV). No IPs / personal data are
 * stored — only summed counters and a 2-letter country → games map.
 *
 * The front-door worker forwards `POST /api/stats` here (stamped with the edge country) and serves
 * `GET /api/stats` from here. All numeric deltas are re-clamped server-side (never trust the client),
 * and `games` is server-controlled (+1 per accepted POST), so the worst a bad actor can do is add a
 * few games at the per-IP rate limit — approximate-by-design, like any public unauthenticated counter.
 */
import {
  type StatsSnapshot,
  type StatsDelta,
  type StatsDeltaNums,
  EMPTY_TOTALS,
  sanitizeDelta,
} from '../src/net/stats';

interface Env {
  STATS: DurableObjectNamespace;
}

/** Map a delta's numeric field to the totals field it accumulates into (all share a name except the
 *  duration, which the DO routes into playTimeSec + longestGameSec separately). */
const SUM_FIELDS: Exclude<keyof StatsDeltaNums, 'gameSec'>[] = [
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

  private async load(): Promise<StatsSnapshot> {
    return (await this.ctx.storage.get<StatsSnapshot>('stats')) ?? freshSnapshot();
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
      t.games += 1; // server-controlled — one game per accepted POST
      if (delta.online) t.onlineGames += 1;
      for (const f of SUM_FIELDS) t[f] += delta[f];
      t.playTimeSec += delta.gameSec;
      t.longestGameSec = Math.max(t.longestGameSec, delta.gameSec);
      s.countries[country] = (s.countries[country] ?? 0) + 1;
      s.updated = Date.now();
      await this.ctx.storage.put('stats', s);
    });

    return json({ok: true});
  }
}

export type {Env as StatsEnv};
