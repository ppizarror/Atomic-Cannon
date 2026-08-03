/**
 * Fills index.html — the static HTML shell — from the string catalog.
 *
 * The shell is the one document a crawler or a link unfurler actually reads (it never runs
 * the game), so it has to carry real prose: the title, the description, the share-card copy
 * and the no-JS pitch. None of that is authored THERE, though — it would be a second copy of
 * text that already lives in i18n/en.ts, and the two would drift. Instead the shell holds
 * `%TOKEN%` placeholders and this module fills them from the source locale, at serve time
 * (Vite dev) and build time (the brand-html plugin in vite.config.ts) alike.
 */

import {GAME_NAME} from './brand.ts';
import {en} from './i18n/en.ts';

/** Every placeholder the shell may use, and the copy that fills it. */
const TOKENS: Readonly<Record<string, string>> = {
  GAME_NAME,
  META_TITLE: en.meta.title,
  META_DESCRIPTION: en.meta.description,
  META_SOCIAL: en.meta.social,
  META_IMAGE_ALT: en.meta.imageAlt,
  NOSCRIPT_PITCH: en.meta.noscript.pitch,
  NOSCRIPT_REQUIRES: en.meta.noscript.requires,
};

/**
 * Escape catalog copy for HTML. Every token lands either in a double-quoted attribute or in
 * element text, and this form is safe in both — so a translator's stray `&` or `"` can never
 * break the `<head>` (or, worse, close an attribute early).
 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Replace every `%TOKEN%` in the shell with its catalog copy. Throws on an unknown token
 * rather than leaving it in the served HTML — a typo'd placeholder fails the build/dev server
 * loudly instead of shipping `%META_TITLE%` to Google.
 */
export function renderShell(html: string): string {
  return html.replace(/%([A-Z_]+)%/g, (token, key: string) => {
    const copy = TOKENS[key];
    if (copy === undefined) throw new Error(`index.html: unknown placeholder ${token}`);
    return escapeHtml(copy);
  });
}
