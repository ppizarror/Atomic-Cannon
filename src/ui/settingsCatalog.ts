/**
 * Single source of truth for every PERSISTED Settings option: its default value and —
 * for the enums the engine reads as a scalar — the index→scalar table.
 *
 * Enum DISPLAY labels used to live here too, but they are localised copy, so they now
 * live in i18n (`strings.settings.<page>.<row>.options`), index-aligned with the `scale`
 * table below. Keep an enum's i18n `options` the same length as its `scale` here — the
 * index the widget stores is shared between them.
 *
 * Only STORED settings live here. Audio (Sound / Music / volumes), Full Screen (reads the
 * document) and Language (lives on the i18n signal) aren't remembered options and aren't
 * listed. `settingsStore.getVal(id)` returns `SETTINGS[id].default`; a widget/getter for
 * an unregistered id is a COMPILE error (`id: SettingId`).
 */
export interface SettingMeta {
  /** Value until the player changes it — raw stored units (enum index / stepper value / 0|1). */
  default: number;
  /** Enum index → engine scalar (e.g. Wind index → wind multiplier). Same length as the
   *  matching i18n `options` array. */
  scale?: readonly number[];
}

const CATALOG = {
  // ── Economy ──
  'eco.buyTime': {default: 0},
  'eco.creditStart': {default: 3000},
  'eco.creditRound': {default: 1000},
  'eco.creditTurn': {default: 0},
  'eco.creditKill': {default: 500},
  'eco.creditDamage': {default: 1},
  'eco.sellBack': {default: 50},

  // ── Tank ── (kickback / player-size carry engine scalars; index → multiplier)
  'tank.kickback': {default: 2, scale: [0, 0.6, 1, 1.5]},
  'tank.size': {default: 1, scale: [0.72, 1, 1.35]},
  'tank.relTurrets': {default: 0},
  'tank.bury': {default: 0},
  'tank.powerScale': {default: 100},
  'tank.hitpoints': {default: 1000},
  'tank.chatter': {default: 1},
  'tank.colorize': {default: 1},

  // ── Gameplay ──
  'gp.battles': {default: 2},
  'gp.rounds': {default: 10},
  'gp.gameType': {default: 1},
  'gp.landSize': {default: 0},
  'gp.difficulty': {default: 4},
  'gp.wind': {default: 0, scale: [0, 0.5, 1, 1.6]},
  'gp.changeWind': {default: 0},
  'gp.explosionSize': {default: 1, scale: [0.7, 1, 1.35, 1.8]},
  'gp.variance': {default: 1},
  'gp.utilTurn': {default: 0},
  'gp.randTurns': {default: 0},
  'gp.crates': {default: 20},
  'gp.updateScale': {default: 10},
  'gp.rcFires': {default: 1},

  // ── Graphics ──
  'gfx.tracking': {default: 1},
  'gfx.smoke': {default: 1},
  'gfx.highContrast': {default: 0},
  'gfx.landType': {default: 5},
  'gfx.aiStats': {default: 0},
  'gfx.teamColor': {default: 1},
  'gfx.smallBuy': {default: 0},

  // ── More Graphics ──
  'gfx.showTurn': {default: 1},
  'gfx.blastCircles': {default: 0},
  'gfx.showPoints': {default: 1},
  'gfx.showPower': {default: 1},
  'gfx.tankStats': {default: 0},
  'gfx.autoScroll': {default: 1},
  'gfx.lastAim': {default: 1},
  'gfx.expWaves': {default: 1},
  'gfx.camShake': {default: 1},
  'gfx.framerate': {default: 0},
  'gfx.fpsCap': {default: 0, scale: [0, 30, 60, 120, 144]},
  'gfx.demo': {default: 0},

  // ── Audio ── (Sound/Music/volumes/Stereo all bind live to CAudio, not stored here)
} satisfies Record<string, SettingMeta>;

/** The id of any stored setting — the keys of the catalog. A widget or engine getter for an
 *  id not in the catalog is a compile error, so a stray key can't slip in. */
export type SettingId = keyof typeof CATALOG;

/** The catalog, widened so `SETTINGS[id]` reads as {@link SettingMeta} (uniform optional
 *  `options`/`scale`) for a dynamic id — the `satisfies` above still type-checks each entry. */
export const SETTINGS: Record<SettingId, SettingMeta> = CATALOG;
