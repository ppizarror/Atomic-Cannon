/**
 * Single source of truth for every PERSISTED Settings option: its default value, the
 * index→scalar table for the enums the engine reads as a scalar, and — for the ~45 that mirror
 * a {@link GameConfig} field — WHICH field they land in (`cfg`). `applyGameConfig` walks this
 * table, so an option's default, its units and its destination all live on ONE line — splitting
 * them across a catalog entry, a hand-written getter in settingsValues and a hand-written
 * assignment in applySettings gives three places that can quietly disagree.
 *
 * Enum DISPLAY labels do NOT live here: they are localised copy, so they live in i18n
 * (`strings.settings.<page>.<row>.options`), index-aligned with the `scale` table below. Keep an
 * enum's i18n `options` the same length as its `scale` here — the index the widget stores is
 * shared between them.
 *
 * Only STORED settings live here. Audio (Sound / Music / volumes), Full Screen (reads the
 * document) and Language (lives on the i18n signal) aren't remembered options and aren't
 * listed. `settingsStore.getVal(id)` returns `SETTINGS[id].default`; a widget/getter for
 * an unregistered id is a COMPILE error (`id: SettingId`).
 */
import type {SettingsMirrorKey} from '../core/CGameConfig';

export interface SettingMeta {
  /** Value until the player changes it — raw stored units (enum index / stepper value). A plain
   *  ON/OFF toggle is written as a `boolean` here purely for readability; `getVal` coerces it to
   *  the stored 0|1 the widgets and engine getters expect, so it reads as a number everywhere else.
   *
   *  It also DECLARES the option's kind, which is what `engineValue` reads: a boolean default
   *  means the engine wants a boolean, a numeric one means a number. */
  default: number | boolean;
  /** Enum index → engine scalar (e.g. Wind index → wind multiplier). Same length as the
   *  matching i18n `options` array. Its presence marks the option as enum-scaled. */
  scale?: readonly number[];
  /**
   * The {@link GameConfig} field this option mirrors. `applyGameConfig` walks the catalog and
   * writes each one, so the binding lives HERE — next to the default — instead of being restated
   * as a hand-written getter plus a hand-written assignment. Omit for the options the controller
   * or the UI consumes instead (credits, battles, difficulty, framerate, …).
   */
  cfg?: SettingsMirrorKey;
  /** Post-read transform from stored units to engine units (e.g. Power Scale % → multiplier).
   *  Applied after the default/scale read; only for the handful that aren't 1:1. */
  map?: (v: number) => number;
  /** Fallback scalar when a stored enum index falls outside {@link scale} (a corrupt value).
   *  Defaults to 1 — the identity for the multiplier enums; the "amount" enums override it to 0. */
  scaleDflt?: number;
}

const CATALOG = {
  // ---- ECONOMY -----------------------------------------------------------
  // Only Buy Time mirrors GameConfig; the credit rates go to the controller.
  'eco.buyTime': {default: 0, cfg: 'buyTime'},
  'eco.creditStart': {default: 3000},
  'eco.creditRound': {default: 1000},
  'eco.creditTurn': {default: 0},
  'eco.creditKill': {default: 500},
  'eco.creditDamage': {default: 1},
  'eco.sellBack': {default: 50, map: v => v / 100}, // stored %, engine fraction

  // ---- TANK --------------------------------------------------------------
  // Kickback / player-size carry engine scalars; index -> multiplier.
  'tank.kickback': {default: 2, scale: [0, 0.6, 1, 1.5], cfg: 'kickbackScale'},
  'tank.size': {default: 1, scale: [0.72, 1, 1.35], cfg: 'tankSizeScale'},
  'tank.relTurrets': {default: false, cfg: 'relativeTurrets'},
  'tank.bury': {default: true, cfg: 'buryTanks'},
  'tank.powerScale': {default: 100, cfg: 'powerScale', map: v => v / 100}, // stored %, engine multiplier
  'tank.hitpoints': {default: 1000, cfg: 'hitpoints'},
  'tank.chatter': {default: true, cfg: 'chatter'},
  'tank.colorize': {default: false, cfg: 'colorizeTeam'},

  // ---- GAMEPLAY ----------------------------------------------------------
  'gp.battles': {default: 2},
  'gp.rounds': {default: 10},
  'gp.gameType': {default: 1},
  'gp.landSize': {default: 0, cfg: 'landSize', map: v => v + 1}, // index 0..4 → 1..5 screens
  'gp.difficulty': {default: 4, map: v => v + 1}, // enum index 0..10 → AI level 1..11 (11 = Ultra)
  'gp.wind': {default: 0, scale: [0, 0.5, 1, 1.6]},
  'gp.changeWind': {default: 0, cfg: 'changeWind'},
  // 0 Linear (uniform) · 1 Realistic (boundary-layer profile)
  'gp.windModel': {default: 0, cfg: 'windModel'},
  'gp.explosionSize': {default: 1, scale: [0.7, 1, 1.35, 1.8], cfg: 'explosionScale'},
  'gp.variance': {default: true},
  // Round Timer seconds; index 0 = Off (infinite turns) — so an out-of-range index means OFF, not 1
  'gp.roundTime': {default: 2, scale: [0, 15, 30, 45], scaleDflt: 0, cfg: 'roundTime'},
  'gp.utilTurn': {default: false, cfg: 'utilityTurn'},
  'gp.randTurns': {default: false, cfg: 'randomizeTurns'},
  // Scatter the spawn slots so squads aren't grouped on the map
  'gp.randPos': {default: true, cfg: 'randomizePosition'},
  'gp.altTurns': {default: true, cfg: 'alternateTurns'},
  // squad-wide weapon pick (off = each tank keeps its own)
  'gp.weaponPersist': {default: false, cfg: 'weaponPersist'},
  'gp.crates': {default: 20, cfg: 'crateChance'},
  'gp.updateScale': {default: 10, map: v => v / 10}, // stored tenths, engine multiplier
  'gp.rcFires': {default: true, cfg: 'rightClickFires'},
  // fallout hurts tanks on it (on) vs cosmetic-only (off, legacy)
  'gp.radiationDamage': {default: true, cfg: 'radiationDamage'},
  // Off by default: it reshapes ground beyond the crater, so it changes where tanks end up
  // standing — a tactical change, not a visual one, and not something legacy did.
  'gp.soilCompaction': {default: false, cfg: 'soilCompaction'},

  // ---- GRAPHICS ----------------------------------------------------------
  'gfx.tracking': {default: true, cfg: 'tracking'},
  'gfx.smoke': {default: true, cfg: 'drawSmoke'},
  // render preset: 0 Old School · 1 Simple · 2 High · 3 Wargame
  'gfx.detail': {default: 2, cfg: 'detail'},
  // fill craters with soil (off = transparent, the faithful default)
  'gfx.craterFill': {default: false, cfg: 'craterFill'},
  'gfx.highContrast': {default: false, cfg: 'highContrast'},
  // Forced landscape shape 0..4; any other index (the default 5 = "Random") means random
  'gfx.landType': {default: 5, map: v => (v >= 0 && v <= 4 ? v : -1)},
  'gfx.aiStats': {default: false, cfg: 'showAiStats'},
  'gfx.teamColor': {default: true, cfg: 'showTeamColor'},
  // Past the status list's row cap, scroll a window of rows that follows the acting player
  'gfx.statusScroll': {default: true, cfg: 'statusScroll'},
  'gfx.smallBuy': {default: false, cfg: 'smallBuyFonts'},
  'gfx.mobileHud': {default: 0}, // touch HUD: 0 Auto (size detection) · 1 On · 2 Off
  'gfx.safeArea': {default: 1}, // mobile notch inset: 0 Off · 1 Notch side only · 2 Both sides (symmetric — clears both rounded corners)
  'gfx.showTurn': {default: true, cfg: 'showTurn'},
  'gfx.blastCircles': {default: false, cfg: 'blastCircles'},
  'gfx.showPoints': {default: true, cfg: 'showPoints'}, // floating damage numbers per hit
  'gfx.showPower': {default: true, cfg: 'showPowerBars'},
  'gfx.tankStats': {default: true, cfg: 'showTankStats'},
  'gfx.autoScroll': {default: true, cfg: 'autoScroll'}, // camera follows the shot / active tank
  // turn hand-off camera: 0 Smooth · 1 Instant · 2 Cinematic
  'gfx.camera': {default: 0, cfg: 'cameraMode'},
  'gfx.lastAim': {default: true, cfg: 'showLastAim'},
  'gfx.expWaves': {default: true, cfg: 'explosionWaves'},
  'gfx.camShake': {default: true, cfg: 'cameraShake'},
  // blow up the non-winning teams when a battle ends (cosmetic)
  'gfx.explodeLosers': {default: true, cfg: 'explodeLosers'},
  'gfx.framerate': {default: 0},
  'gfx.fpsCap': {default: 0, scale: [0, 30, 60, 120, 144], scaleDflt: 0},
  'gfx.demo': {default: false, cfg: 'demo'},
  'gfx.ambientLight': {default: true, cfg: 'ambientLight'},
  'gfx.hideSplash': {default: false}, // hide the tilted "fan recreation" splash on the title screen

  // ---- AUDIO -------------------------------------------------------------
  // Sound/Music/volumes/Stereo all bind live to CAudio, not stored here.
} satisfies Record<string, SettingMeta>;

/** The id of any stored setting — the keys of the catalog. A widget or engine getter for an
 *  id not in the catalog is a compile error, so a stray key can't slip in. */
export type SettingId = keyof typeof CATALOG;

/** The catalog, widened so `SETTINGS[id]` reads as a uniform {@link SettingMeta} for a DYNAMIC id
 *  — the `satisfies` above still type-checks each entry against it. */
export const SETTINGS: Record<SettingId, SettingMeta> = CATALOG;
