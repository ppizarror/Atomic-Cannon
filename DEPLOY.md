# Deploying the multiplayer server (Cloudflare)

The whole game — static client **and** the multiplayer backend — ships as one
Cloudflare Worker: a Worker script routes `/room/<CODE>` WebSockets to a **Durable
Object** (one per room) and serves the built client from the **assets** binding. Idle
rooms hibernate, so cost is ~$0 for normal play (see `MULTIPLAYER.md` §7).

## Prerequisites

- A Cloudflare account (the free plan is enough to start).
- `wrangler` is already a dev dependency — no global install needed.
- Authenticate once (opens a browser):

  ```bash
  pnpm exec wrangler login
  ```

  Or, for CI / headless, set an API token instead:

  ```bash
  export CLOUDFLARE_API_TOKEN=…   # token with "Edit Workers" permissions
  ```

## Deploy

```bash
./scripts/deploy.sh     # auth-check → build → deploy (recommended)
# — or the raw steps —
pnpm build              # produce dist/ (the client the Worker serves)
pnpm deploy:net         # wrangler deploy
```

The first deploy automatically applies the Durable Object migration (`v1`,
`new_sqlite_classes: ["Room"]`) — no manual step. By default the Worker serves from a
`*.workers.dev` URL, which wrangler prints at the end; to serve from your own domain
instead, see "Custom domain" below.

Verify: open that URL, **Network Game → Create**, copy the code, open the URL in a
second window/browser, **Join** with the code. You should land in the same lobby and,
after **Start**, play a synced match.

## What's configured (`wrangler.jsonc`)

| Binding                           | Purpose                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| `ROOM` (Durable Object, SQLite)   | one instance per room code; roster, turn arbiter, latest snapshot |
| `ASSETS` (dist/)                  | the static client, with SPA fallback to `index.html`              |
| `ROOM_LIMIT` (Rate Limit, 30/60s) | per-IP cap on `/api/new` room creation                            |

Server-side guards already in place: version check on join, per-room `maxPlayers`,
turn-ownership validation, a 128 KB frame-size cap, and the room-creation rate limit.

## Custom domain

`wrangler.jsonc` is intentionally **domain-agnostic** so the public repo reveals no
hostname — out of the box the Worker serves from `*.workers.dev`. To serve from your own
domain, keep the hostname in a local, gitignored file instead of committing it:

```bash
cp scripts/deploy.env.example scripts/deploy.env
# edit scripts/deploy.env → DEPLOY_HOSTNAME=atomic.example.com
./scripts/deploy.sh
```

When `DEPLOY_HOSTNAME` is set (env var or `scripts/deploy.env`), `deploy.sh` injects a
`custom_domain` route into a throwaway config copy and deploys that:

```jsonc
"routes": [{"pattern": "<your-host>", "custom_domain": true}],
"workers_dev": false,
```

Requirements & effects:

- The domain's **zone must be active on the same Cloudflare account** you deploy with
  (its nameservers pointed at Cloudflare).
- `custom_domain: true` auto-provisions the DNS record + TLS cert on first deploy — no
  manual DNS step (the cert can take a minute to go green).
- `workers_dev: false` turns off the `*.workers.dev` URL, so the game is reachable **only**
  at your domain.

`scripts/deploy.env` and the generated `.wrangler.deploy.jsonc` are gitignored, so the
hostname never lands in git. `wrangler dev` / `pnpm dev:net` ignore all of this and run
locally as before.

## SEO / link previews

Search and social metadata needs **absolute** URLs, which the repo cannot store (see
"Custom domain" above). So the Worker derives them from the live request origin — whatever
host it is actually served from — and nothing needs configuring:

- `/robots.txt` and `/sitemap.xml` are generated per request (`src/seo.ts`), pointing at
  that origin and keeping crawlers off `/api/` and `/room/`. This needs the Worker to see
  the request at all, hence `run_worker_first` in `wrangler.jsonc` — real static files
  (`/assets/*`, `/audio/*`, images, `sw.js`) still bypass the Worker entirely.
- The HTML shell ships root-relative `og:url` / `og:image`; `worker/seo.ts` rewrites them to
  absolute on the way out and appends the tags that exist only in absolute form — the
  canonical link and the schema.org `VideoGame` JSON-LD.
- The social card is `public/screenshot.jpg` (1200×630, served at `/screenshot.jpg`).
  Regenerate it from a fresh capture when the game's look changes.

Only the deployed Worker injects this — `pnpm dev` / `pnpm preview` serve the relative
tags as-is. After a first deploy, submit the domain in Google Search Console and re-scrape
the card at [Facebook's sharing debugger](https://developers.facebook.com/tools/debug/).

## Cost & monitoring

- **Free tier:** 100k requests/day, ~13k GB-s/day, 5 GB SQLite. A full 4-player match
  is ~20 billable requests, so this covers thousands of games/day (`MULTIPLAYER.md` §7).
- Watch usage in the Cloudflare dashboard → **Workers & Pages → your Worker →
  Metrics**. `observability` is enabled, so logs/metrics are on.
- If you outgrow the free tier, the **Workers Paid** plan is $5/mo.

## Rollback

```bash
pnpm exec wrangler deployments list      # find a previous version id
pnpm exec wrangler rollback [<version>]  # revert
```

## Hardening ideas (later, if it goes public)

- Add a WAF rate-limit / bot-fight rule in the dashboard for extra `/api/new` and
  connection protection.
- Tighten `ROOM_LIMIT` (`limit`/`period`) if abuse appears.
- A public game browser (a lobby-registry DO/KV) — intentionally out of scope for
  private code-join play.
