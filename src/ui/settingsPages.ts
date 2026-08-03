/**
 * Option-page specs for the Settings tree — the widget rows for each category, with their
 * labels + hover tooltips. Each row is a `Widget`: a toggle (ON/OFF), an int/float stepper,
 * an enum cycle, or a nav row.
 *
 * All presentation copy (labels / tips / enum value labels / page headers) comes from i18n
 * (`strings.settings.*`); the builders read it at call time, so the whole tree re-renders
 * in the new language when the locale changes. Stored rows get their id's DEFAULT and enum
 * SCALE from `settingsCatalog` (SETTINGS). Audio rows read/write CAudio directly and the
 * Language row drives the i18n locale signal — one live source of truth each. A row's game
 * effect is wired via `applyGameSettings`.
 */
import {signal} from '@preact/signals';
import {strings, fmt, locale, setLocale, availableLocales, localeName} from '../i18n';
import type {RowCopy} from '../i18n';
import {getVal, setVal} from './settingsStore';
import {type SettingId} from './settingsCatalog';
import {game, openSettingsPage, isMobile, viewportH} from './store';
import {clamp} from '../math/num';
import {applyGameSettings} from './applySettings';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

export type WidgetKind = 'toggle' | 'stepper' | 'enum' | 'nav';

export interface Widget {
  label: string;
  /** Hover subtitle (the option's description). */
  tip: string;
  kind: WidgetKind;
  get: () => number; // current value (enum index / raw stepper / 0-1 toggle)
  set?: (v: number) => void;
  options?: readonly string[]; // enum labels (from i18n)
  min?: number;
  max?: number;
  step?: number;
  fmt?: (v: number) => string; // stepper
  onClick?: () => void; // nav
}

export interface PageSpec {
  id: string;
  /** Page header desc — shown as the bottom subtitle when no row is hovered. */
  header: string;
  rows: Widget[];
}

// ==========================================================================
// WIDGET BUILDERS
// ==========================================================================

/** Percent formatter for stepper values (localised suffix). */
const pct = (v: number): string => fmt(strings.value.settings.percent, {n: v});

export const bind = (id: SettingId) => ({
  get: () => getVal(id),
  set: (v: number) => {
    setVal(id, v);
    applyGameSettings(game());
  },
});
const toggle = (c: RowCopy, id: SettingId): Widget => ({
  label: c.label,
  tip: c.tip,
  kind: 'toggle',
  ...bind(id),
});
export const enumW = (c: RowCopy, id: SettingId): Widget => ({
  label: c.label,
  tip: c.tip,
  kind: 'enum',
  options: c.options,
  ...bind(id),
});
export const stepper = (
  c: RowCopy,
  id: SettingId,
  min: number,
  max: number,
  step: number,
  fmtFn?: (v: number) => string,
): Widget => ({
  label: c.label,
  tip: c.tip,
  kind: 'stepper',
  min,
  max,
  step,
  fmt: fmtFn,
  ...bind(id),
});

/** A navigation row that opens another settings page (carries no stored value). */
const navRow = (c: RowCopy, target: string): Widget => ({
  label: c.label,
  tip: c.tip,
  kind: 'nav',
  get: () => 0,
  onClick: () => openSettingsPage(target),
});

// ==========================================================================
// PAGE ROW DEFINITIONS
// ==========================================================================

function economyRows(): Widget[] {
  const s = strings.value.settings.economy;
  return [
    enumW(s.buyTime, 'eco.buyTime'),
    stepper(s.creditStart, 'eco.creditStart', 0, 20000, 500),
    stepper(s.creditRound, 'eco.creditRound', 0, 10000, 250),
    stepper(s.creditTurn, 'eco.creditTurn', 0, 5000, 100),
    stepper(s.creditKill, 'eco.creditKill', 0, 5000, 100),
    stepper(s.creditDamage, 'eco.creditDamage', 0, 100, 1),
    stepper(s.sellBack, 'eco.sellBack', 0, 100, 5, pct),
  ];
}

function tankRows(): Widget[] {
  const s = strings.value.settings.tank;
  return [
    enumW(s.kickback, 'tank.kickback'),
    enumW(s.size, 'tank.size'),
    toggle(s.relTurrets, 'tank.relTurrets'),
    toggle(s.bury, 'tank.bury'),
    stepper(s.powerScale, 'tank.powerScale', 10, 300, 10, pct),
    stepper(s.hitpoints, 'tank.hitpoints', 100, 5000, 100),
    toggle(s.chatter, 'tank.chatter'),
    toggle(s.colorize, 'tank.colorize'),
  ];
}

function gameplayRows(): Widget[] {
  const s = strings.value.settings.gameplay;
  return [
    stepper(s.battles, 'gp.battles', 1, 50, 1),
    stepper(s.rounds, 'gp.rounds', 1, 50, 1),
    // Difficulty is a stored preference (persisted + applied via applyGameSettings →
    // controller.setDifficulty); index 0..10 maps to AI level 1..11 (the last being Ultra).
    enumW(s.difficulty, 'gp.difficulty'),
    enumW(s.wind, 'gp.wind'),
    enumW(s.changeWind, 'gp.changeWind'),
    enumW(s.windModel, 'gp.windModel'),
    enumW(s.explosionSize, 'gp.explosionSize'),
    toggle(s.variance, 'gp.variance'),
    enumW(s.roundTime, 'gp.roundTime'),
    toggle(s.utilTurn, 'gp.utilTurn'),
    toggle(s.randTurns, 'gp.randTurns'),
    toggle(s.randPos, 'gp.randPos'),
    toggle(s.altTurns, 'gp.altTurns'),
    toggle(s.weaponPersist, 'gp.weaponPersist'),
    stepper(s.crates, 'gp.crates', 0, 100, 5, pct),
    stepper(s.updateScale, 'gp.updateScale', 1, 30, 1),
    toggle(s.rcFires, 'gp.rcFires'),
    toggle(s.radiation, 'gp.radiationDamage'),
    toggle(s.soilCompaction, 'gp.soilCompaction'),
  ];
}

/** Language cycle — a live row backed by the i18n locale signal (not a stored SettingId).
 *  Options are the shipped locales in their own names; index = current locale's slot. */
function languageRow(s: RowCopy): Widget {
  return {
    label: s.label,
    tip: s.tip,
    kind: 'enum',
    options: availableLocales.map(localeName),
    get: () => Math.max(0, availableLocales.indexOf(locale.value)),
    set: (v: number) => {
      const code = availableLocales[v];
      if (code) setLocale(code);
    },
  };
}

function graphicsRows(): Widget[] {
  const s = strings.value.settings.graphics;
  // Real fullscreen via the Fullscreen API; reads the live document state so it stays
  // reactive (leaving fullscreen with Esc flips it back to OFF on its own). Hidden on
  // mobile — the API is unavailable/blocked there (notably iOS Safari) and the touch
  // layout already fills the screen.
  const fullScreen: Widget = {
    label: s.fullScreen.label,
    tip: s.fullScreen.tip,
    kind: 'toggle',
    get: () => (typeof document !== 'undefined' && document.fullscreenElement ? 1 : 0),
    set: (v: number) => {
      if (typeof document === 'undefined') return;
      if (v) void document.documentElement.requestFullscreen?.();
      else void document.exitFullscreen?.();
    },
  };
  return [
    ...(isMobile.value ? [] : [fullScreen]),
    languageRow(s.language),
    toggle(s.tracking, 'gfx.tracking'),
    toggle(s.smoke, 'gfx.smoke'),
    enumW(s.detail, 'gfx.detail'),
    toggle(s.craterFill, 'gfx.craterFill'),
    toggle(s.highContrast, 'gfx.highContrast'),
    enumW(s.landType, 'gfx.landType'),
    toggle(s.aiStats, 'gfx.aiStats'),
    toggle(s.teamColor, 'gfx.teamColor'),
    toggle(s.statusScroll, 'gfx.statusScroll'),
    toggle(s.smallBuy, 'gfx.smallBuy'),
    enumW(s.mobileHud, 'gfx.mobileHud'),
    // Notch avoidance is only meaningful on a mobile/touch device with a safe-area inset.
    ...(isMobile.value ? [enumW(s.safeArea, 'gfx.safeArea')] : []),
    toggle(s.showTurn, 'gfx.showTurn'),
    toggle(s.blastCircles, 'gfx.blastCircles'),
    toggle(s.showPoints, 'gfx.showPoints'),
    toggle(s.showPower, 'gfx.showPower'),
    toggle(s.tankStats, 'gfx.tankStats'),
    toggle(s.autoScroll, 'gfx.autoScroll'),
    enumW(s.camera, 'gfx.camera'),
    toggle(s.lastAim, 'gfx.lastAim'),
    toggle(s.expWaves, 'gfx.expWaves'),
    toggle(s.camShake, 'gfx.camShake'),
    enumW(s.framerate, 'gfx.framerate'),
    enumW(s.fpsCap, 'gfx.fpsCap'),
    toggle(s.demo, 'gfx.demo'),
    toggle(s.ambientLight, 'gfx.ambientLight'),
    toggle(s.explodeLosers, 'gfx.explodeLosers'),
    toggle(s.hideSplash, 'gfx.hideSplash'),
  ];
}

function audioRows(): Widget[] {
  const s = strings.value.settings.audio;
  const a = game().getAudio();
  return [
    {
      label: s.sound.label,
      tip: s.sound.tip,
      kind: 'toggle',
      get: () => (a?.isSfxEnabled() ? 1 : 0),
      set: (v: number) => a?.setSfxEnabled(!!v),
    },
    {
      label: s.music.label,
      tip: s.music.tip,
      kind: 'toggle',
      get: () => (a?.isMusicEnabled() ? 1 : 0),
      set: (v: number) => a?.setMusicEnabled(!!v),
    },
    {
      // CAudio volumes are already 0..100 (percent) — pass through, don't rescale.
      label: s.soundVol.label,
      tip: s.soundVol.tip,
      kind: 'stepper',
      min: 0,
      max: 100,
      step: 10,
      fmt: pct,
      get: () => Math.round(a?.getSfxVolume() ?? 100),
      set: (v: number) => a?.setSfxVolume(v),
    },
    {
      label: s.musicVol.label,
      tip: s.musicVol.tip,
      kind: 'stepper',
      min: 0,
      max: 100,
      step: 10,
      fmt: pct,
      get: () => Math.round(a?.getMusicVolume() ?? 100),
      set: (v: number) => a?.setMusicVolume(v),
    },
    {
      // Stereo binds live to CAudio (like the volumes), not a stored preference.
      label: s.stereo.label,
      tip: s.stereo.tip,
      kind: 'toggle',
      get: () => (a?.isStereo() ? 1 : 0),
      set: (v: number) => a?.setStereo(!!v),
    },
    {
      // Non-legacy menu navigation blips (hover / forward / back) — opt-in, OFF by default.
      label: s.menuSounds.label,
      tip: s.menuSounds.tip,
      kind: 'toggle',
      get: () => (a?.isMenuSfxEnabled() ? 1 : 0),
      set: (v: number) => a?.setMenuSfxEnabled(!!v),
    },
  ];
}

function contentRows(): Widget[] {
  // Weapons / Landscapes open dedicated enable-list editors (over the steel plate).
  const s = strings.value.settings.content;
  return [navRow(s.weapons, 'content.weapons'), navRow(s.landscapes, 'content.landscapes')];
}

// ==========================================================================
// PAGINATION
// ==========================================================================

/** Row PITCH in px (height + the list's gap), measured off a real rendered row by SettingsPage and
 *  published here. 0 = nothing rendered yet. Measuring beats a constant: the row is bitmap glyphs
 *  plus padding, and the mobile list carries a CSS `zoom`, so its true pitch (32.8px at zoom 0.8 vs
 *  41px) falls out of the measurement instead of needing a second hardcoded number. */
export const settingsRowPitch = signal(0);

/** Fraction of the viewport a page's rows may fill before it splits. Not 100%: the page also carries
 *  a title above and a hover subtitle below, and a list running to the very edge reads as clipped. */
const PAGE_HEIGHT_FRACTION = 0.6;
/** Slots the list spends on things that aren't options: the "More Options" nav and the Done button. */
const RESERVED_ROWS = 2;
/** Fallbacks for the very first paint, before a row exists to measure. */
const FALLBACK_SIZE = {mobile: 6, desktop: 10};

/** Max real options shown on one settings page; anything longer auto-splits into sub-pages, each
 *  ending in a free "More Options" nav. Derived from how many rows actually FIT — a fixed 6/10 leaves
 *  a tall phone showing 6 rows over a third of the screen while a short desktop window overflows. */
const pageSize = (): number => {
  const pitch = settingsRowPitch.value;
  if (pitch <= 0) return isMobile.value ? FALLBACK_SIZE.mobile : FALLBACK_SIZE.desktop;
  const slots = Math.floor((viewportH.value * PAGE_HEIGHT_FRACTION) / pitch) - RESERVED_ROWS;
  // Floor of 3 so a tiny viewport still paginates instead of producing empty pages; the ceiling
  // just stops one page swallowing every option on an enormous screen.
  return clamp(slots, 3, 30);
};

/** Slice a category's full row list to the requested sub-page, appending a "next page" nav to every
 *  page but the last. The sub-page index rides in the route id as `<base>~<n>` (page 0 = bare id),
 *  and back always returns to root — the sub-pages are a flat nav, not a stack to unwind. */
function paginate(base: string, allRows: Widget[], pageIdx: number): Widget[] {
  const size = pageSize();
  const start = pageIdx * size;
  const rows = allRows.slice(start, start + size);
  if (start + size < allRows.length) {
    const c = strings.value.settings.nextPage;
    rows.push(navRow(c, `${base}~${pageIdx + 1}`));
  }
  return rows;
}

// ==========================================================================
// PAGE LOOKUP
// ==========================================================================

export function getSettingsPage(id: string): PageSpec | null {
  const s = strings.value.settings;
  // Route ids carry an optional `~<page>` suffix for auto-paginated sub-pages.
  const sep = id.indexOf('~');
  const base = sep >= 0 ? id.slice(0, sep) : id;
  const pageIdx = sep >= 0 ? Math.max(0, parseInt(id.slice(sep + 1), 10) || 0) : 0;
  const paged = (header: string, allRows: Widget[]): PageSpec => ({
    id,
    header,
    rows: paginate(base, allRows, pageIdx),
  });
  switch (base) {
    case 'economy':
      return paged(s.economy.header, economyRows());
    case 'tank':
      return paged(s.tank.header, tankRows());
    case 'gameplay':
      return paged(s.gameplay.header, gameplayRows());
    case 'graphics':
      return paged(s.graphics.header, graphicsRows());
    case 'audio':
      return paged(s.audio.header, audioRows());
    case 'content':
      return paged(s.content.header, contentRows());
    default:
      return null;
  }
}
