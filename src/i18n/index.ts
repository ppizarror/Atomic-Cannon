/**
 * Localisation entry point. Holds the active-locale signal (persisted) and the
 * reactive `strings` table the UI reads. Adding a language = author one more
 * `Strings` table (see en.ts) and register it in CATALOG; every call site updates
 * automatically because it reads `strings.value`.
 */
import {computed, signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';
import {en} from './en';
import type {LocaleCode, Strings} from './types';

export type {LocaleCode, Strings, AboutSection} from './types';

const CATALOG: Record<LocaleCode, Strings> = {en};
const KEY = 'atomic.locale';

/** Locales the build ships with (catalog keys), for a future language picker. */
export const availableLocales = Object.keys(CATALOG) as LocaleCode[];

function load(): LocaleCode {
  const v = loadJSON<LocaleCode | null>(KEY, null);
  return v && v in CATALOG ? v : 'en';
}

/** The active locale. Default 'en'; restored from storage on boot. */
export const locale = signal<LocaleCode>(load());

/** Switch + persist the locale (ignored if the code isn't in the catalog). */
export function setLocale(code: LocaleCode): void {
  if (!(code in CATALOG)) return;
  locale.value = code;
  saveJSON(KEY, code);
}

/** Reactive string table for the active locale — the one thing the UI reads. */
export const strings = computed<Strings>(() => CATALOG[locale.value]);
