/**
 * Keeps the DOCUMENT itself — `<html lang>`, `<title>`, the description and the
 * Open Graph / Twitter tags — in the player's language, and the tab title on the screen
 * they're actually looking at ("Atomic Cannon — Weapons Depot").
 *
 * index.html ships this metadata statically in ENGLISH, which is the right default: a
 * crawler or a link unfurler reads the served HTML and never runs the game, so that copy
 * is what gets indexed and what appears in a share card. But a player who switches to
 * Español would otherwise keep an English browser tab and an `<html lang="en">` document
 * — wrong for screen readers and for the browser's "translate this page?" heuristics.
 * So the live document is restamped from the i18n catalog whenever the locale changes.
 *
 * Restamping only affects THIS browser's copy of the page; it changes nothing about what
 * search engines see (see src/seo.ts for that half — the Worker serves one canonical
 * English shell whose JSON-LD already declares `inLanguage: ['en', 'es']`).
 */
import {computed, effect} from '@preact/signals';
import {GAME_NAME} from '../brand';
import {LOCALES, availableLocales, fmt, locale, stringsFor} from '../i18n';
import type {LocaleCode, TitleSection} from '../i18n';
import {loading, screen, showDepot, showHelp, showPause} from './store';

/**
 * Which screen the tab should name, or `null` on the main menu — where the title stays the
 * full marketing headline from the catalog, because that's the resting screen a crawler that
 * renders the page ends up on (and the one a bookmark is taken from).
 *
 * This is the same navigation state the URL router mirrors (store.currentPath), read here as
 * signals so the title tracks Back/Forward and ESC for free.
 */
export const titleSection = computed<TitleSection | null>(() => {
  if (loading.value) return 'loading'; // a launching match, whatever screen is underneath
  switch (screen.value) {
    case 'menu':
      return null;
    case 'battle':
      if (showHelp.value) return 'help';
      if (showDepot.value) return 'depot';
      if (showPause.value) return 'paused';
      return 'battle';
    case 'setup':
      return 'play';
    case 'highscores':
      return 'highScores';
    default:
      return screen.value; // settings | about | manual | network — ids match one-to-one
  }
});

/** The `<title>` for a locale + screen: the full headline on the menu, "{game} — {section}"
 *  anywhere else. Share tags do NOT use this — see applyDocumentMeta. */
export function documentTitle(code: LocaleCode, section: TitleSection | null): string {
  const {meta} = stringsFor(code);
  if (!section) return meta.title;
  return fmt(meta.sectionTitle, {game: GAME_NAME, section: meta.sections[section]});
}

/**
 * Re-write `<title>` even when the string hasn't changed — clearing it first, so the assignment
 * is a real DOM mutation the browser has to notice.
 *
 * The browser stores the tab title in the session-history ENTRY and restores it on a
 * same-document Back/Forward. Every overlay close pops a route (see store.popRoute), so closing
 * the depot hands the tab back the title that entry was pushed with — "Weapons Depot" — and it
 * sticks there for the rest of the match. `document.title` in the DOM is already correct by
 * then, which is exactly why the effect below can't repair it: re-assigning the same string
 * mutates nothing, so the browser never re-reads it and the tab stays stale.
 */
export function restampTitle(doc: Document, code: LocaleCode, section: TitleSection | null): void {
  doc.title = '';
  doc.title = documentTitle(code, section);
}

/** `og:locale` for a code (`en` → `en_US`) — OG wants language_TERRITORY, not a bare tag. */
const ogLocale = (code: LocaleCode): string => LOCALES.find(l => l.code === code)?.ogLocale ?? code;

/** Set one `<meta {attr}="{key}">`, creating the tag if index.html doesn't ship it. */
function setMeta(doc: Document, attr: 'name' | 'property', key: string, content: string): void {
  let el = doc.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = doc.createElement('meta');
    el.setAttribute(attr, key);
    doc.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

/**
 * Stamp `doc` with the metadata for `code`, with the tab title naming `section` (null = the
 * main menu). Separate from the effect below so it can be driven with a stub document in tests.
 *
 * Only `<title>` follows the player: og/twitter keep the marketing headline, so a link
 * unfurled from a paused battle still reads as the game rather than "Paused".
 */
export function applyDocumentMeta(doc: Document, code: LocaleCode, section: TitleSection | null = null): void {
  const {title, description, social} = stringsFor(code).meta;
  doc.documentElement.lang = code;
  doc.title = documentTitle(code, section);
  setMeta(doc, 'name', 'description', description);
  setMeta(doc, 'property', 'og:title', title);
  setMeta(doc, 'property', 'og:description', social);
  setMeta(doc, 'property', 'og:locale', ogLocale(code));
  setMeta(doc, 'name', 'twitter:title', title);
  setMeta(doc, 'name', 'twitter:description', social);
  // The alternates are every OTHER shipped locale, so they have to be rebuilt (not just
  // rewritten) on a switch: one tag per alternate, and which ones they are changes.
  for (const el of doc.head.querySelectorAll('meta[property="og:locale:alternate"]')) el.remove();
  for (const alt of availableLocales.filter(c => c !== code)) setAlternate(doc, ogLocale(alt));
}

/** Append one `og:locale:alternate` (repeatable, so it can't go through setMeta). */
function setAlternate(doc: Document, value: string): void {
  const el = doc.createElement('meta');
  el.setAttribute('property', 'og:locale:alternate');
  el.setAttribute('content', value);
  doc.head.appendChild(el);
}

/**
 * Track the active locale + current screen for the life of the page. Call once at boot.
 * `doc`/`win` default to the live globals; tests pass stubs. Returns a teardown.
 */
export function watchDocumentMeta(doc: Document = document, win: Window = window): () => void {
  const stop = effect(() => applyDocumentMeta(doc, locale.value, titleSection.value));
  // A history traversal restores the entry's stored tab title over ours, and the effect above
  // won't undo that (see restampTitle) — so force the title back after every one. Deferred a
  // whole task, not a microtask: this listener is registered BEFORE the router's (app.tsx boots
  // the document meta first), and only once its handler has run does `titleSection` name the
  // screen we actually landed on.
  const onPop = (): void => {
    setTimeout(() => restampTitle(doc, locale.value, titleSection.value), 0);
  };
  win.addEventListener('popstate', onPop);
  return () => {
    stop();
    win.removeEventListener('popstate', onPop);
  };
}
