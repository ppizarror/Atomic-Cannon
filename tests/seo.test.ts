/**
 * Crawler-facing metadata: robots.txt / sitemap.xml / JSON-LD build absolute URLs from the
 * request origin (never a hard-coded host), and index.html carries the static half in the
 * exact shape the Worker's rewriter expects — root-relative canonical/og URLs, description
 * matching SITE_DESCRIPTION, and an og:image path the Vite build actually emits.
 */
import {readFileSync} from 'node:fs';
import {describe, it, expect} from 'vitest';
import {
  robotsTxt,
  sitemapXml,
  jsonLd,
  headTags,
  SITE_NAME,
  SITE_DESCRIPTION,
  OG_IMAGE_PATH,
} from '../src/seo';

const ORIGIN = 'https://play.example.com';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** The content/href of a <meta>/<link> tag, tolerating Prettier's multi-line attributes. */
const tagUrl = (attrs: string): string | null => {
  const re = new RegExp(`<(?:meta|link)[^>]*${attrs}[^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  return tag ? (/(?:content|href)="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
};

describe('robots.txt', () => {
  it('points at the sitemap on the same origin', () => {
    expect(robotsTxt(ORIGIN)).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('keeps crawlers out of the multiplayer endpoints but allows the game', () => {
    const txt = robotsTxt(ORIGIN);
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Disallow: /api/');
    expect(txt).toContain('Disallow: /room/');
  });
});

describe('sitemap.xml', () => {
  it('lists the root of the requesting origin only (every route is the same shell)', () => {
    const xml = sitemapXml(ORIGIN);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml.match(/<url>/g)).toHaveLength(1);
  });
});

describe('JSON-LD', () => {
  it('describes a free, playable browser game with absolute URLs', () => {
    const data = JSON.parse(jsonLd(ORIGIN));
    expect(data['@type']).toBe('VideoGame');
    expect(data.name).toBe(SITE_NAME);
    expect(data.description).toBe(SITE_DESCRIPTION);
    expect(data.url).toBe(`${ORIGIN}/`);
    expect(data.image).toBe(`${ORIGIN}${OG_IMAGE_PATH}`);
    expect(data.isAccessibleForFree).toBe(true);
    expect(data.offers.price).toBe('0');
  });

  it('cannot break out of its <script> element', () => {
    expect(jsonLd('https://x.test/</script><script>alert(1)</script>')).not.toContain('<');
  });
});

describe('Worker-injected head tags', () => {
  it('canonicalises to the root of the requesting origin', () => {
    expect(headTags(ORIGIN)).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
  });

  it('carries the JSON-LD blob', () => {
    expect(headTags(ORIGIN)).toContain('"@type":"VideoGame"');
  });

  it('escapes a spoofed Host so the canonical href cannot inject markup', () => {
    // The origin comes from the request URL — i.e. from a header a client controls.
    const tags = headTags('https://evil"><script>alert(1)</script><b x="');
    expect(tags).not.toContain('<script>alert(1)</script>');
  });
});

describe('index.html', () => {
  it('describes the page with the same copy as SITE_DESCRIPTION', () => {
    expect(tagUrl('name="description"')).toBe(SITE_DESCRIPTION);
  });

  it('keeps the og URLs root-relative so the Worker can absolutise them', () => {
    // worker/seo.ts only rewrites values starting with "/" — an absolute or bare value
    // would silently ship a wrong (or host-leaking) URL to every crawler.
    expect(tagUrl('property="og:url"')).toBe('/');
    expect(tagUrl('property="og:image"')).toBe(OG_IMAGE_PATH);
    expect(tagUrl('name="twitter:image"')).toBe(OG_IMAGE_PATH);
  });

  it('ships crawlable copy and a title beyond the bare product name', () => {
    expect(/<title>([^<]+)<\/title>/.exec(html)?.[1].length).toBeGreaterThan(20);
    // The prose lives in <noscript> so it can never flash on screen before the game boots.
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';
    expect(noscript).toMatch(/<h1>Atomic Cannon<\/h1>/);
    expect(noscript).toMatch(/artillery/i);
  });

  it('renders nothing of its own before the game mounts', () => {
    // Regression guard: a visible boot splash reads as a black text page flashing ahead of
    // the title screen. Everything outside <head>/<noscript> must stay an empty mount point.
    const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
    expect(body.replace(/<noscript>[\s\S]*?<\/noscript>/, '')).not.toMatch(/>[A-Za-z]/);
  });

  it('leaks no deploy hostname', () => {
    expect(html).not.toMatch(/https?:\/\/(?!schema\.org|www\.w3\.org)/);
  });
});
