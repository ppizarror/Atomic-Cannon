/**
 * Search/social metadata that depends on the deployed ORIGIN — robots.txt, the
 * sitemap, and the JSON-LD structured-data blob.
 *
 * The repo is deliberately domain-agnostic (see wrangler.jsonc: the hostname lives only
 * in the gitignored scripts/deploy.env), so nothing here hard-codes a host. The Worker
 * passes the live `new URL(req.url).origin` — which is the custom domain in production
 * and the *.workers.dev URL otherwise — so any fork gets correct absolute URLs for free.
 *
 * Isomorphic: no DOM, no Node, no Workers API — plain string building, imported by the
 * Worker (worker/seo.ts) and exercised by tests.
 */

/** Canonical product name (Open Graph `og:site_name`, schema.org `name`). */
export const SITE_NAME = 'Atomic Cannon';

/**
 * The one-line pitch shown in search results and link previews.
 * KEEP IN SYNC with `<meta name="description">` in index.html — test/seo.test.ts asserts it.
 */
export const SITE_DESCRIPTION =
  'Play Atomic Cannon free in your browser: a turn-based artillery duel on destructible ' +
  'terrain. Aim, read the wind, buy nukes, and out-shoot bots or friends.';

/** Social card image (1200x630), served from public/ — see og:image in index.html. */
export const OG_IMAGE_PATH = '/screenshot.jpg';

/**
 * Origins come from the request's Host header, so never splice one into HTML unescaped.
 * (A parsed `URL.origin` can't actually hold these characters — this is belt and braces.)
 */
const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The `<head>` tags that can only be built once the origin is known, as an HTML fragment for
 * the Worker to append (worker/seo.ts).
 *
 * The canonical link lives here rather than in index.html for a mundane reason too: Vite's
 * build-html pass treats every `<link href>` as an asset reference, and `href="/"` resolves
 * to the project root — a directory — which fails the build.
 */
export function headTags(origin: string): string {
  return (
    `<link rel="canonical" href="${attr(origin)}/">` +
    `<script type="application/ld+json">${jsonLd(origin)}</script>`
  );
}

/** `robots.txt`: index the game, keep crawlers out of the multiplayer endpoints. */
export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    // Not content: /api/* is JSON and /room/* is a WebSocket upgrade (426 to a crawler).
    'Disallow: /api/',
    'Disallow: /room/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/**
 * `sitemap.xml`: a single entry for the root. Every in-app route (/settings, /manual, a
 * room code, …) serves the exact same SPA shell, so they all canonicalise to `/` — listing
 * them would just be duplicate content.
 */
export function sitemapXml(origin: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url>\n' +
    `    <loc>${origin}/</loc>\n` +
    '    <changefreq>weekly</changefreq>\n' +
    '    <priority>1.0</priority>\n' +
    '  </url>\n' +
    '</urlset>\n'
  );
}

/**
 * schema.org `VideoGame` structured data, as the JSON text for an
 * `<script type="application/ld+json">`. This is what lets a search engine understand the
 * page is a free, playable browser game rather than an empty canvas.
 *
 * `<` is escaped so the payload can never terminate the surrounding <script> element.
 */
export function jsonLd(origin: string): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: SITE_NAME,
    alternateName: 'Atomic Cannon Web',
    url: `${origin}/`,
    image: `${origin}${OG_IMAGE_PATH}`,
    description: SITE_DESCRIPTION,
    applicationCategory: 'GameApplication',
    genre: ['Artillery', 'Strategy', 'Turn-based'],
    gamePlatform: 'Web browser',
    playMode: ['SinglePlayer', 'MultiPlayer'],
    operatingSystem: 'Any (modern web browser)',
    browserRequirements: 'Requires JavaScript and WebGL',
    inLanguage: ['en', 'es'],
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
  }).replace(/</g, '\\u003c');
}
