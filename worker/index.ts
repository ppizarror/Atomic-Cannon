/**
 * Worker front door: mints room codes, routes each
 * `wss://…/room/<CODE>` upgrade to the one Durable Object named by that code, and
 * otherwise serves the static client from the assets binding.
 */
import {newRoomCode, normalizeRoomCode, isValidRoomCode} from '../src/net/roomCode';

export {Room} from './Room';
export {Stats} from './Stats';

interface Env {
  ROOM: DurableObjectNamespace;
  STATS: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Per-IP limiter on room creation (see `ratelimits` in wrangler.jsonc). */
  ROOM_LIMIT: RateLimit;
  /** Per-IP limiter on stats uploads. */
  STATS_LIMIT: RateLimit;
}

/** The single global Stats DO instance. */
const statsStub = (env: Env) => env.STATS.get(env.STATS.idFromName('global'));

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json'},
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Mint a fresh, shareable room code. (Collision odds at 31^6 are negligible;
    // the DO is created lazily on first connect, so no reservation is needed.)
    // Rate-limited per client IP so one host can't spin up rooms in a loop.
    if (url.pathname === '/api/new') {
      const ip = req.headers.get('CF-Connecting-IP') ?? 'anon';
      const {success} = await env.ROOM_LIMIT.limit({key: ip});
      if (!success) return json({error: 'slow down — too many rooms'}, 429);
      return json({code: newRoomCode()});
    }

    // Global play stats. GET = the aggregate for the About screen (short-cached); POST = one finished
    // match's delta, stamped with the visitor's edge country and folded into the global Stats DO.
    if (url.pathname === '/api/stats') {
      if (req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') ?? 'anon';
        const {success} = await env.STATS_LIMIT.limit({key: ip});
        if (!success) return json({error: 'slow down'}, 429);
        let delta: unknown;
        try {
          delta = await req.json();
        } catch {
          return json({error: 'bad body'}, 400);
        }
        const country = (req as {cf?: {country?: string}}).cf?.country ?? 'XX';
        return statsStub(env).fetch(
          new Request('https://do/stats', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({delta, country}),
          }),
        );
      }
      // GET — pass the aggregate through with a brief edge cache so a spike of About visits can't
      // hammer the DO.
      const res = await statsStub(env).fetch(new Request('https://do/stats'));
      return new Response(await res.text(), {
        status: res.status,
        headers: {'content-type': 'application/json', 'cache-control': 'public, max-age=30'},
      });
    }

    // WebSocket join: /room/<CODE>
    const m = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (m) {
      const code = normalizeRoomCode(decodeURIComponent(m[1]));
      if (!isValidRoomCode(code)) return json({error: 'invalid room code'}, 400);
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', {status: 426});
      }
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // Pass the human code so the DO can learn its own name.
      const fwd = new URL(req.url);
      fwd.searchParams.set('code', code);
      return stub.fetch(new Request(fwd.toString(), req));
    }

    // Everything else: the static client (Pages/assets binding).
    return env.ASSETS.fetch(req);
  },
};
