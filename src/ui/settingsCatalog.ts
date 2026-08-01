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
  /** Value until the player changes it — raw stored units (enum index / stepper value). A plain
   *  ON/OFF toggle is written as a `boolean` here purely for readability; `getVal` coerces it to
   *  the stored 0|1 the widgets and engine getters expect, so it reads as a number everywhere else. */
  default: number | boolean;
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
  'tank.relTurrets': {default: false},
  'tank.bury': {default: true},
  'tank.powerScale': {default: 100},
  'tank.hitpoints': {default: 1000},
  'tank.chatter': {default: true},
  'tank.colorize': {default: false},

  // ── Gameplay ──
  'gp.battles': {default: 2},
  'gp.rounds': {default: 10},
  'gp.gameType': {default: 1},
  'gp.landSize': {default: 0},
  'gp.difficulty': {default: 4},
  'gp.wind': {default: 0, scale: [0, 0.5, 1, 1.6]},
  'gp.changeWind': {default: 0},
  'gp.windModel': {default: 0}, // 0 Linear (uniform) · 1 Realistic (boundary-layer profile)
  'gp.explosionSize': {default: 1, scale: [0.7, 1, 1.35, 1.8]},
  'gp.variance': {default: true},
  'gp.roundTime': {default: 2, scale: [0, 15, 30, 45]}, // Round Timer seconds; index 0 = Off (infinite turns)
  'gp.utilTurn': {default: false},
  'gp.randTurns': {default: false},
  'gp.randPos': {default: true}, // Scatter the spawn slots so squads aren't grouped on the map
  'gp.altTurns': {default: true},
  'gp.weaponPersist': {default: false}, // squad-wide weapon pick (off = each tank keeps its own)
  'gp.crates': {default: 20},
  'gp.updateScale': {default: 10},
  'gp.rcFires': {default: true},
  'gp.radiationDamage': {default: true}, // fallout hurts tanks on it (on) vs cosmetic-only (off, legacy)

  // ── Graphics ──
  'gfx.tracking': {default: true},
  'gfx.smoke': {default: true},
  'gfx.detail': {default: 2}, // render preset: 0 Old School · 1 Simple · 2 High · 3 Wargame
  'gfx.craterFill': {default: false}, // fill craters with soil (off = transparent, the faithful default)
  'gfx.highContrast': {default: false},
  'gfx.landType': {default: 5},
  'gfx.aiStats': {default: false},
  'gfx.teamColor': {default: true},
  // Past the status list's row cap, scroll a window of rows that follows the acting player
  'gfx.statusScroll': {default: true},
  'gfx.smallBuy': {default: false},
  'gfx.mobileHud': {default: 0}, // touch HUD: 0 Auto (size detection) · 1 On · 2 Off
  'gfx.safeArea': {default: 1}, // mobile notch inset: 0 Off · 1 Notch side only · 2 Both sides (symmetric — clears both rounded corners)
  'gfx.showTurn': {default: true},
  'gfx.blastCircles': {default: false},
  'gfx.showPoints': {default: true},
  'gfx.showPower': {default: true},
  'gfx.tankStats': {default: true},
  'gfx.autoScroll': {default: true},
  'gfx.camera': {default: 0}, // turn hand-off camera: 0 Smooth · 1 Instant · 2 Cinematic
  'gfx.lastAim': {default: true},
  'gfx.expWaves': {default: true},
  'gfx.camShake': {default: true},
  'gfx.explodeLosers': {default: true}, // blow up the non-winning teams when a battle ends (cosmetic)
  'gfx.framerate': {default: 0},
  'gfx.fpsCap': {default: 0, scale: [0, 30, 60, 120, 144]},
  'gfx.demo': {default: false},
  'gfx.ambientLight': {default: true},
  'gfx.hideSplash': {default: false}, // hide the tilted "fan recreation" splash on the title screen

  // ── Audio ── (Sound/Music/volumes/Stereo all bind live to CAudio, not stored here)
} satisfies Record<string, SettingMeta>;

/** The id of any stored setting — the keys of the catalog. A widget or engine getter for an
 *  id not in the catalog is a compile error, so a stray key can't slip in. */
export type SettingId = keyof typeof CATALOG;

/** The catalog, widened so `SETTINGS[id]` reads as {@link SettingMeta} (uniform optional
 *  `options`/`scale`) for a dynamic id — the `satisfies` above still type-checks each entry. */
export const SETTINGS: Record<SettingId, SettingMeta> = CATALOG;
