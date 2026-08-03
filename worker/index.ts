/**
 * Worker front door: mints room codes, routes each
 * `wss://…/room/<CODE>` upgrade to the one Durable Object named by that code, serves the
 * profile-sync API, and otherwise serves the static client from the assets binding (with the
 * origin-dependent SEO metadata injected — see worker/seo.ts).
 */
import {newRoomCode, normalizeRoomCode, isValidRoomCode} from '../src/net/roomCode';
import {newProfileCode, normalizeProfileCode, isValidProfileCode} from '../src/net/profileCode';
import {PROFILE_MAX_BYTES, isPayload, payloadBytes} from '../src/net/profile';
import {robotsTxt, sitemapXml} from '../src/seo';
import {withSeo} from './seo';
import {json, JSON_TYPE, rateLimit} from './http';

export {Room} from './Room';
export {Stats} from './Stats';
export {Profile} from './Profile';

interface Env {
  ROOM: DurableObjectNamespace;
  STATS: DurableObjectNamespace;
  PROFILE: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Per-IP limiter on room creation (see `ratelimits` in wrangler.jsonc). */
  ROOM_LIMIT: RateLimit;
  /** Per-IP limiter on stats uploads. */
  STATS_LIMIT: RateLimit;
  /** Per-IP limiter on profile reads/writes — also what makes guessing ids hopeless in practice. */
  PROFILE_LIMIT: RateLimit;
}

/** The single global Stats DO instance. */
const statsStub = (env: Env) => env.STATS.get(env.STATS.idFromName('global'));

/** The Profile DO named by a profile id — the id IS the instance name. */
const profileStub = (env: Env, code: string) => env.PROFILE.get(env.PROFILE.idFromName(code));

/** Attempts to find a free id when minting. Collisions at 31^12 are effectively impossible;
 *  this exists so the one-in-a-quintillion case fails safe instead of returning a taken id. */
const MINT_TRIES = 3;

/** Forward a DO response verbatim (status + JSON body) to the client. */
const passthrough = async (res: Response): Promise<Response> =>
  new Response(await res.text(), {status: res.status, headers: JSON_TYPE});

/**
 * Claim a fresh profile id for `payload`, re-rolling if the slot somehow already holds a save.
 * Attempts are necessarily SEQUENTIAL — each one must be seen to fail before another id is
 * burned — so this recurses rather than looping, and never issues speculative parallel writes.
 */
async function mintProfile(env: Env, payload: string, triesLeft: number): Promise<Response> {
  const code = newProfileCode();
  const res = await profileStub(env, code).fetch(
    new Request('https://do/profile', {method: 'POST', headers: JSON_TYPE, body: payload}),
  );
  if (res.status === 409) {
    if (triesLeft <= 1) return json({error: 'could not allocate a profile id'}, 503);
    return mintProfile(env, payload, triesLeft - 1);
  }
  if (!res.ok) return passthrough(res);
  const out = (await res.json()) as {rev?: number; updated?: number};
  return json({code, rev: out.rev ?? 1, updated: out.updated ?? 0});
}

const text = (body: string, contentType: string): Response =>
  new Response(body, {
    headers: {'content-type': contentType, 'cache-control': 'public, max-age=3600'},
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Crawler files. Generated per-request so the absolute URLs inside them match whatever
    // origin this Worker is actually served from (custom domain or *.workers.dev) — the repo
    // itself stores no hostname.
    if (url.pathname === '/robots.txt') {
      return text(robotsTxt(url.origin), 'text/plain; charset=utf-8');
    }
    if (url.pathname === '/sitemap.xml') {
      return text(sitemapXml(url.origin), 'application/xml; charset=utf-8');
    }

    // Mint a fresh, shareable room code. (Collision odds at 31^6 are negligible;
    // the DO is created lazily on first connect, so no reservation is needed.)
    // Rate-limited per client IP so one host can't spin up rooms in a loop.
    if (url.pathname === '/api/new') {
      const limited = await rateLimit(req, env.ROOM_LIMIT, 'slow down — too many rooms');
      if (limited) return limited;
      return json({code: newRoomCode()});
    }

    // Global play stats. GET = the aggregate for the About screen (short-cached); POST = one finished
    // match's delta, stamped with the visitor's edge country and folded into the global Stats DO.
    if (url.pathname === '/api/stats') {
      if (req.method === 'POST') {
        const limited = await rateLimit(req, env.STATS_LIMIT, 'slow down');
        if (limited) return limited;
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
            headers: JSON_TYPE,
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

    // Profile sync — the player's cloud save, keyed by a 12-char id they write down. Rate-limited
    // per IP across reads AND writes: the read limit is what turns "guess an id" from a slow
    // attack into an impossible one, since there is no other secret protecting a profile.
    if (url.pathname === '/api/profile' || url.pathname.startsWith('/api/profile/')) {
      const limited = await rateLimit(req, env.PROFILE_LIMIT, 'slow down');
      if (limited) return limited;

      // POST /api/profile — mint a fresh id holding this device's data. The SERVER picks the id
      // (and re-rolls if the slot is somehow occupied) so a client can never claim one in use.
      if (url.pathname === '/api/profile') {
        if (req.method !== 'POST') return json({error: 'method not allowed'}, 405);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({error: 'bad body'}, 400);
        }
        const data = (body as {data?: unknown} | null)?.data;
        if (!isPayload(data)) return json({error: 'bad payload'}, 400);
        if (payloadBytes(data) > PROFILE_MAX_BYTES) return json({error: 'profile too large'}, 413);
        return mintProfile(env, JSON.stringify({data}), MINT_TRIES);
      }

      // GET/PUT /api/profile/<CODE> — read or compare-and-swap one profile.
      const code = normalizeProfileCode(decodeURIComponent(url.pathname.slice('/api/profile/'.length)));
      if (!isValidProfileCode(code)) return json({error: 'invalid profile id'}, 400);
      if (req.method !== 'GET' && req.method !== 'PUT') return json({error: 'method not allowed'}, 405);
      let body: string | undefined;
      if (req.method === 'PUT') {
        body = await req.text();
        // Cheap early reject so an oversized upload never reaches the DO; the DO re-checks the
        // payload itself, since that is where the storage invariant actually lives.
        if (body.length > PROFILE_MAX_BYTES * 2) return json({error: 'profile too large'}, 413);
      }
      return passthrough(
        await profileStub(env, code).fetch(
          new Request('https://do/profile', {method: req.method, headers: JSON_TYPE, body}),
        ),
      );
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

    // Everything else: the static client (Pages/assets binding). HTML responses get the
    // absolute canonical/og URLs + JSON-LD stamped in on the way out.
    return withSeo(await env.ASSETS.fetch(req), url.origin);
  },
};
