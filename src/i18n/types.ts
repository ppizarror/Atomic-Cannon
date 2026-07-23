/**
 * Localised UI copy. Everything the interface shows in prose lives in a per-locale
 * `Strings` table so adding a language is a matter of dropping in one more table —
 * no strings are hard-coded at the call sites. Long-form copy (the About screen) is
 * stored as flowing paragraphs and wrapped to the panel width at draw time (see
 * wrapText), so a translation of any length re-flows correctly without hand-tuned
 * line breaks.
 */

/** One block of the About screen: an optional heading, flowing body paragraphs, and
 *  an optional bullet list. Each paragraph / bullet is a single flowing string. */
export interface AboutSection {
  heading?: string;
  body?: string[];
  bullets?: string[];
}

export interface Strings {
  /** Big title on the About card. */
  aboutTitle: string;
  /** One-line subtitle under the title. */
  aboutSubtitle: string;
  /** The credits / story document, top to bottom. */
  about: AboutSection[];
  /** Main-menu link to the project's source repository. */
  repoLabel: string;
  /** Generic "back" action label (About card). */
  back: string;
}

/** Codes of the locales that ship with the game. Extend as tables are added. */
export type LocaleCode = 'en';
