/**
 * Localisation entry point. Holds the active-locale signal (persisted) and the
 * reactive `strings` table the UI reads. Adding a language = author one more
 * `Strings` table (see en.ts) and register it in CATALOG + LOCALES; every call site
 * updates automatically because it reads `strings.value`.
 *
 * First-boot locale is auto-detected from the browser's language preferences
 * (`navigator.languages`), falling back to English when none of them ship. Once the
 * player picks a language explicitly it is remembered and detection no longer runs.
 */
import {computed, signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';
import {en} from './en';
import {es} from './es';
import type {LocaleCode, LocaleInfo, Strings} from './types';

export type {
  LocaleCode,
  LocaleInfo,
  Strings,
  AboutSection,
  WeaponCopy,
  RowCopy,
  EntryCopy,
  HelpItem,
} from './types';

const CATALOG: Record<LocaleCode, Strings> = {en, es};
const KEY = 'atomic.locale';

/** The default / fallback locale — used when nothing else resolves. */
export const DEFAULT_LOCALE: LocaleCode = 'en';

/** Shipped locales in picker order, each with its endonym (name in its own language). */
export const LOCALES: readonly LocaleInfo[] = [
  {code: 'en', name: 'English'},
  {code: 'es', name: 'Español'},
];

/** Locale codes the build ships with (catalog keys) — the language picker's options. */
export const availableLocales = LOCALES.map(l => l.code);

/** Picker display name for a locale code (its endonym), or the raw code if unknown. */
export function localeName(code: LocaleCode): string {
  return LOCALES.find(l => l.code === code)?.name ?? code;
}

/** Best-fit shipped locale for the browser's language preferences, else the default.
 *  Matches on the primary subtag (`en-US` → `en`) in preference order. */
export function detectLocale(): LocaleCode {
  const prefs =
    typeof navigator !== 'undefined'
      ? (navigator.languages ?? [navigator.language]).filter(Boolean)
      : [];
  for (const pref of prefs) {
    const base = pref.toLowerCase().split('-')[0];
    const hit = availableLocales.find(code => code === base);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

/** Stored preference, or an auto-detected locale on first run (nothing persisted). */
function load(): LocaleCode {
  const v = loadJSON<LocaleCode | null>(KEY, null);
  if (v && v in CATALOG) return v;
  return detectLocale();
}

/** The active locale. Auto-detected on first boot; restored from storage afterwards. */
export const locale = signal<LocaleCode>(load());

/** Switch + persist the locale (ignored if the code isn't in the catalog). */
export function setLocale(code: LocaleCode): void {
  if (!(code in CATALOG)) return;
  locale.value = code;
  saveJSON(KEY, code);
}

/** Reactive string table for the active locale — the one thing the UI reads. */
export const strings = computed<Strings>(() => CATALOG[locale.value]);

/** Fill `{token}` placeholders in a template from `vars` (missing tokens are left as-is).
 *  `fmt('Battle {n} of {total}', {n: 2, total: 5})` → "Battle 2 of 5". */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
