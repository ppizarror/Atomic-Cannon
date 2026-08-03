/**
 * Serves the origin-dependent half of the page's search/social metadata.
 *
 * index.html ships the origin-INDEPENDENT tags (title, description, og:title, …) plus
 * ROOT-RELATIVE og:url/og:image. Crawlers and link unfurlers (Facebook, X, Discord,
 * WhatsApp) require ABSOLUTE URLs there, and the repo never stores its hostname — so the
 * Worker rewrites those attributes against the live request origin on the way out, and
 * appends the tags that only exist in absolute form (canonical + JSON-LD). One pass, no
 * duplicated tags: a statically-hosted dist/ still has the relative versions.
 */
import {headTags} from '../src/seo';

/** Tags whose URL must be absolute; `link` carries it in href, the metas in content. */
const ABSOLUTE_URL_TAGS = 'meta[property="og:url"], meta[property="og:image"], meta[name="twitter:image"]';

/** Rewrite an asset response in place when it is the HTML shell; anything else passes through. */
export function withSeo(res: Response, origin: string): Response {
  const type = res.headers.get('content-type') ?? '';
  if (res.status !== 200 || !type.includes('text/html')) return res;

  // The injected head changes the byte length; a stale Content-Length would truncate it.
  // The ETag is kept: the transform is deterministic for a given origin, so it still
  // identifies the bytes the client will receive (a 304 skips this path entirely).
  const html = new Response(res.body, res);
  html.headers.delete('content-length');

  return new HTMLRewriter()
    .on(ABSOLUTE_URL_TAGS, {
      element(el) {
        const attr = el.tagName === 'link' ? 'href' : 'content';
        const value = el.getAttribute(attr);
        if (value?.startsWith('/')) el.setAttribute(attr, origin + value);
      },
    })
    .on('head', {
      element(el) {
        el.append(headTags(origin), {html: true});
      },
    })
    .transform(html);
}
