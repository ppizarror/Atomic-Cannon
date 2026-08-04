/**
 * Crawler-facing metadata: robots.txt / sitemap.xml / JSON-LD build absolute URLs from the
 * request origin (never a hard-coded host), and index.html carries the static half in the
 * exact shape the Worker's rewriter expects — root-relative canonical/og URLs and an
 * og:image path the Vite build actually emits.
 *
 * The shell's PROSE is generated from the catalog (src/shell.ts), so these tests render it
 * the same way the dev server and the build do, then assert each slot got the right copy.
 *
 * Plus the LIVE half: ui/documentMeta restamps the same tags — and the per-screen tab title
 * — from the catalog as the player moves around and switches language.
 */
import {readFileSync} from 'node:fs';
import {describe, it, expect, vi} from 'vitest';
import {robotsTxt, sitemapXml, jsonLd, headTags, SITE_DESCRIPTION, OG_IMAGE_PATH} from '../src/seo';
import {GAME_NAME} from '../src/brand';
import {escapeHtml, renderShell} from '../src/shell';
import {availableLocales, stringsFor} from '../src/i18n';
import type {TitleSection} from '../src/i18n';
import {applyDocumentMeta, documentTitle, titleSection, watchDocumentMeta} from '../src/ui/documentMeta';
import {loading, screen, showDepot, showPause} from '../src/ui/store';

const ORIGIN = 'https://play.example.com';
const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// What a browser (or a crawler) actually receives: the shell with its placeholders filled.
const html = renderShell(source);

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
  it('describes a playable browser game with absolute URLs', () => {
    const data = JSON.parse(jsonLd(ORIGIN));
    expect(data['@type']).toBe('VideoGame');
    expect(data.name).toBe(GAME_NAME);
    expect(data.description).toBe(SITE_DESCRIPTION);
    expect(data.url).toBe(`${ORIGIN}/`);
    expect(data.image).toBe(`${ORIGIN}${OG_IMAGE_PATH}`);
  });

  it('credits the original instead of claiming to be it, and sells nothing', () => {
    const data = JSON.parse(jsonLd(ORIGIN));
    expect(data.isBasedOn.author.name).toBe('Isotope 244');
    expect(data.offers).toBeUndefined();
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
    expect(tagUrl('name="description"')).toBe(escapeHtml(SITE_DESCRIPTION));
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
    const {noscript: ns} = stringsFor('en').meta;
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';
    expect(noscript).toContain(`<h1>${GAME_NAME}</h1>`);
    expect(noscript).toContain(escapeHtml(ns.pitch));
    expect(noscript).toContain(escapeHtml(ns.requires));
    expect(noscript).toMatch(/artillery/i);
  });

  it('renders nothing of its own before the game mounts', () => {
    // A visible boot splash reads as a black text page flashing ahead of the title screen —
    // everything outside <head>/<noscript> must stay an empty mount point.
    const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
    expect(body.replace(/<noscript>[\s\S]*?<\/noscript>/, '')).not.toMatch(/>[A-Za-z]/);
  });

  it('leaks no deploy hostname', () => {
    expect(html).not.toMatch(/https?:\/\/(?!schema\.org|www\.w3\.org)/);
  });

  it('authors no copy of its own — every word comes from the catalog', () => {
    // The point of src/shell.ts: renaming the game, or rewording the pitch, is a one-file
    // edit in i18n/en.ts. Nothing a reader sees may be typed into the shell.
    const en = stringsFor('en').meta;
    expect(source).not.toContain(GAME_NAME);
    for (const copy of [en.title, en.description, en.social, en.imageAlt, en.noscript.pitch])
      expect(source).not.toContain(copy);
    expect(source).toMatch(/%[A-Z_]+%/);
  });

  it('fills every placeholder it uses (and leaves none behind)', () => {
    // An unknown placeholder throws at render — better a failed build than %META_TITLE%
    // showing up in a search result.
    expect(html).not.toMatch(/%[A-Z_]+%/);
    expect(() => renderShell('<title>%NOT_A_TOKEN%</title>')).toThrow(/unknown placeholder/);
  });
});

/** A <head>-only stand-in for `document` — enough of the API for applyDocumentMeta. */
function stubDoc() {
  interface El {
    attrs: Record<string, string>;
    setAttribute(k: string, v: string): void;
    remove(): void;
  }
  let els: El[] = [];
  const match = (sel: string): El[] => {
    const m = /^meta\[(\w+)="([^"]+)"\]$/.exec(sel);
    return m ? els.filter(e => e.attrs[m[1]] === m[2]) : [];
  };
  const create = (): El => {
    const e: El = {
      attrs: {},
      setAttribute: (k, v) => {
        e.attrs[k] = v;
      },
      remove: () => {
        els = els.filter(x => x !== e);
      },
    };
    return e;
  };
  const doc = {
    documentElement: {lang: 'en'},
    title: '',
    head: {
      querySelector: (sel: string) => match(sel)[0] ?? null,
      querySelectorAll: (sel: string) => match(sel),
      appendChild: (e: El) => els.push(e),
    },
    createElement: create,
  };
  return {
    doc: doc as unknown as Document,
    /** Every `content` for a selector, in document order. */
    contents: (sel: string): string[] => match(sel).map(e => e.attrs.content),
  };
}

describe('document metadata (live locale switch)', () => {
  it('pours the English catalog into the right slots of index.html', () => {
    // Not a drift guard any more (the shell is generated from this table) but a WIRING one:
    // every slot has to get the field meant for it — og:description takes the short social
    // line, not the search-result description.
    const en = stringsFor('en').meta;
    expect(/<title>([^<]+)<\/title>/.exec(html)?.[1]).toBe(escapeHtml(en.title));
    expect(tagUrl('property="og:title"')).toBe(escapeHtml(en.title));
    expect(tagUrl('name="twitter:title"')).toBe(escapeHtml(en.title));
    expect(tagUrl('property="og:description"')).toBe(escapeHtml(en.social));
    expect(tagUrl('name="twitter:description"')).toBe(escapeHtml(en.social));
    expect(tagUrl('property="og:image:alt"')).toBe(escapeHtml(en.imageAlt));
    expect(tagUrl('property="og:site_name"')).toBe(GAME_NAME);
  });

  it('restamps the tab title, lang and share tags when the locale changes', () => {
    const {doc, contents} = stubDoc();
    const es = stringsFor('es').meta;
    applyDocumentMeta(doc, 'es');
    expect(doc.documentElement.lang).toBe('es');
    expect(doc.title).toBe(es.title);
    expect(contents('meta[name="description"]')).toEqual([es.description]);
    expect(contents('meta[property="og:title"]')).toEqual([es.title]);
    expect(contents('meta[property="og:description"]')).toEqual([es.social]);
    expect(contents('meta[name="twitter:description"]')).toEqual([es.social]);
    expect(contents('meta[property="og:locale"]')).toEqual(['es_ES']);
    expect(contents('meta[property="og:locale:alternate"]')).toEqual(['en_US']);
  });

  it('switching back leaves one tag per property (no duplicates piling up)', () => {
    const {doc, contents} = stubDoc();
    applyDocumentMeta(doc, 'es');
    applyDocumentMeta(doc, 'en');
    expect(doc.documentElement.lang).toBe('en');
    expect(contents('meta[name="description"]')).toEqual([SITE_DESCRIPTION]);
    expect(contents('meta[property="og:locale"]')).toEqual(['en_US']);
    expect(contents('meta[property="og:locale:alternate"]')).toEqual(['es_ES']);
  });

  it('gives every shipped locale usable head copy', () => {
    for (const code of availableLocales) {
      const m = stringsFor(code).meta;
      expect(m.title.length).toBeGreaterThan(20);
      expect(m.description.length).toBeGreaterThan(60);
      // Search engines truncate well before this; a longer one means a run-on paragraph
      // landed in the snippet slot.
      expect(m.description.length).toBeLessThanOrEqual(200);
      expect(m.social.length).toBeGreaterThan(60);
      expect(m.imageAlt.length).toBeGreaterThan(20);
      expect(m.noscript.pitch.length).toBeGreaterThan(60);
      expect(m.noscript.requires.length).toBeGreaterThan(20);
    }
  });
});

describe('browser tab title (per screen)', () => {
  it('keeps the full marketing headline on the main menu', () => {
    // The resting screen: what a rendering crawler reads, and what a bookmark is named.
    expect(documentTitle('en', null)).toBe(stringsFor('en').meta.title);
  });

  it('names the current screen everywhere else, always brand-first', () => {
    expect(documentTitle('en', 'settings')).toBe(`${GAME_NAME} — Settings`);
    expect(documentTitle('en', 'depot')).toBe(`${GAME_NAME} — Weapons Depot`);
    expect(documentTitle('es', 'paused')).toBe(`${GAME_NAME} — En Pausa`);
  });

  it('leaves the share tags on the headline, whatever screen is open', () => {
    // A link unfurled from a paused battle must still read as the game, not "Paused".
    const {doc, contents} = stubDoc();
    const en = stringsFor('en').meta;
    applyDocumentMeta(doc, 'en', 'paused');
    expect(doc.title).not.toBe(en.title);
    expect(contents('meta[property="og:title"]')).toEqual([en.title]);
    expect(contents('meta[name="twitter:title"]')).toEqual([en.title]);
  });

  it('labels every screen in every shipped locale', () => {
    const keys = Object.keys(stringsFor('en').meta.sections) as TitleSection[];
    for (const code of availableLocales) {
      const m = stringsFor(code).meta;
      expect(m.sectionTitle).toContain('{game}');
      expect(m.sectionTitle).toContain('{section}');
      expect(Object.keys(m.sections).sort()).toEqual([...keys].sort());
      // A missing/blank label would silently render "Atomic Cannon — ".
      for (const k of keys) expect(documentTitle(code, k).trim().length).toBeGreaterThan(GAME_NAME.length + 2);
    }
  });

  it('re-stamps the title after a history Back, even when the string is unchanged', () => {
    // The browser stores the tab title in the session-history ENTRY and restores it on a
    // same-document Back/Forward — so closing an overlay (which pops a route) leaves the tab
    // reading "— Weapons Depot" for the rest of the match. document.title is already correct by
    // then, so re-assigning the same string mutates nothing and the tab never refreshes:
    // restampTitle has to CLEAR first. Verified against real Chrome via the tab title (CDP
    // Target.getTargetInfo) — document.title alone can't tell the two builds apart.
    const {doc} = stubDoc();
    const writes: string[] = [];
    Object.defineProperty(doc, 'title', {
      get: () => writes[writes.length - 1] ?? '',
      set: (v: string) => void writes.push(v),
    });
    const handlers: Array<() => void> = [];
    const win = {
      addEventListener: (_t: string, fn: () => void) => void handlers.push(fn),
      removeEventListener: () => {},
    } as unknown as Window;

    vi.useFakeTimers();
    screen.value = 'battle';
    showDepot.value = true;
    const stop = watchDocumentMeta(doc, win);
    expect(doc.title).toBe(`${GAME_NAME} — Weapons Depot`);

    showDepot.value = false; // closeDepot: the effect writes the right title...
    const n = writes.length;
    for (const fn of handlers) fn(); // ...then popRoute()'s history.back() lands here
    vi.runAllTimers();
    expect(writes.slice(n)).toEqual(['', `${GAME_NAME} — Playing`]);

    stop();
    vi.useRealTimers();
    screen.value = 'menu';
  });

  it('follows the navigation signals — screen, battle overlay, and loading', () => {
    // `screen` starts on 'battle' (the boot title screen) until main.tsx reaches goToMenu.
    screen.value = 'menu';
    expect(titleSection.value).toBe(null);
    screen.value = 'settings';
    expect(titleSection.value).toBe('settings');
    screen.value = 'battle';
    expect(titleSection.value).toBe('battle');
    showPause.value = true;
    expect(titleSection.value).toBe('paused');
    // Loading a match wins over whatever screen is underneath it.
    loading.value = true;
    expect(titleSection.value).toBe('loading');
    loading.value = false;
    showPause.value = false;
    screen.value = 'menu';
    expect(titleSection.value).toBe(null);
  });
});
