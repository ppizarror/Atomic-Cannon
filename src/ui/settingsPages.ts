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
import {strings, fmt, locale, setLocale, availableLocales, localeName} from '../i18n';
import type {RowCopy} from '../i18n';
import {getVal, setVal} from './settingsStore';
import {type SettingId} from './settingsCatalog';
import {game, openSettingsPage} from './store';
import {applyGameSettings} from './applySettings';

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

/** Percent formatter for stepper values (localised suffix). */
const pct = (v: number): string => fmt(strings.value.settings.percent, {n: v});

// ── stored-preference widget builders ────────────────────────────────────────
// Default + enum scale come from SETTINGS[id]; label/tip/options come from the passed
// i18n `RowCopy`. Every stored change persists AND re-applies live, so wired options take
// effect immediately and start-time ones are ready for the next game.
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

// ── pages ────────────────────────────────────────────────────────────────────
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
    // controller.setDifficulty); index 0..9 maps to AI level 1..10.
    enumW(s.difficulty, 'gp.difficulty'),
    enumW(s.wind, 'gp.wind'),
    enumW(s.changeWind, 'gp.changeWind'),
    enumW(s.windModel, 'gp.windModel'),
    enumW(s.explosionSize, 'gp.explosionSize'),
    toggle(s.variance, 'gp.variance'),
    toggle(s.utilTurn, 'gp.utilTurn'),
    toggle(s.randTurns, 'gp.randTurns'),
    toggle(s.altTurns, 'gp.altTurns'),
    stepper(s.crates, 'gp.crates', 0, 100, 5, pct),
    stepper(s.updateScale, 'gp.updateScale', 1, 30, 1),
    toggle(s.rcFires, 'gp.rcFires'),
    toggle(s.radiation, 'gp.radiationDamage'),
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
  return [
    {
      // Real fullscreen via the Fullscreen API; reads the live document state so it
      // stays reactive (leaving fullscreen with Esc flips it back to OFF on its own).
      label: s.fullScreen.label,
      tip: s.fullScreen.tip,
      kind: 'toggle',
      get: () => (typeof document !== 'undefined' && document.fullscreenElement ? 1 : 0),
      set: (v: number) => {
        if (typeof document === 'undefined') return;
        if (v) void document.documentElement.requestFullscreen?.();
        else void document.exitFullscreen?.();
      },
    },
    languageRow(s.language),
    toggle(s.tracking, 'gfx.tracking'),
    toggle(s.smoke, 'gfx.smoke'),
    enumW(s.detail, 'gfx.detail'),
    toggle(s.craterFill, 'gfx.craterFill'),
    toggle(s.highContrast, 'gfx.highContrast'),
    enumW(s.landType, 'gfx.landType'),
    toggle(s.aiStats, 'gfx.aiStats'),
    toggle(s.teamColor, 'gfx.teamColor'),
    toggle(s.smallBuy, 'gfx.smallBuy'),
    toggle(s.showTurn, 'gfx.showTurn'),
    toggle(s.blastCircles, 'gfx.blastCircles'),
    toggle(s.showPoints, 'gfx.showPoints'),
    toggle(s.showPower, 'gfx.showPower'),
    toggle(s.tankStats, 'gfx.tankStats'),
    toggle(s.autoScroll, 'gfx.autoScroll'),
    toggle(s.lastAim, 'gfx.lastAim'),
    toggle(s.expWaves, 'gfx.expWaves'),
    toggle(s.camShake, 'gfx.camShake'),
    enumW(s.framerate, 'gfx.framerate'),
    enumW(s.fpsCap, 'gfx.fpsCap'),
    toggle(s.demo, 'gfx.demo'),
    toggle(s.ambientLight, 'gfx.ambientLight'),
    toggle(s.explodeLosers, 'gfx.explodeLosers'),
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

/** Max real options shown on one settings page. Anything longer auto-splits into sub-pages, each
 *  ending in a free "More Options" nav (the nav itself does NOT count toward the cap). */
const PAGE_SIZE = 10;

/** Slice a category's full row list to the requested sub-page, appending a "next page" nav to every
 *  page but the last. The sub-page index rides in the route id as `<base>~<n>` (page 0 = bare id),
 *  and back always returns to root — matching the flat nav the manual "More …" rows used before. */
function paginate(base: string, allRows: Widget[], pageIdx: number): Widget[] {
  const start = pageIdx * PAGE_SIZE;
  const rows = allRows.slice(start, start + PAGE_SIZE);
  if (start + PAGE_SIZE < allRows.length) {
    const c = strings.value.settings.nextPage;
    rows.push(navRow(c, `${base}~${pageIdx + 1}`));
  }
  return rows;
}

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
