/**
 * Single source of truth for every PERSISTED Settings option: its default value, and —
 * for enum options — the display labels plus (where the engine needs one) the index→scalar
 * table, CO-LOCATED so labels and scalars can't drift in length.
 *
 * Three files used to repeat this: settingsPages (widget default + enum labels),
 * settingsValues (default again + the scalar tables), and PlaySetup (a few rows verbatim).
 * Now they all read from here — `settingsStore.getVal(id)` returns `SETTINGS[id].default`,
 * a widget/getter for an unregistered id is a COMPILE error (`id: SettingId`), and an enum's
 * labels and scalars sit side by side.
 *
 * Only STORED settings live here. Audio (Sound / Music / volumes) binds straight to CAudio
 * and Full Screen reads the document, so they aren't remembered options and aren't listed.
 */
export interface SettingMeta {
  /** Value until the player changes it — raw stored units (enum index / stepper value / 0|1). */
  default: number;
  /** Enum display labels, index 0 first (enum widgets only). */
  options?: readonly string[];
  /** Enum index → engine scalar (e.g. Wind index → wind multiplier). Same length as `options`. */
  scale?: readonly number[];
}

const CATALOG = {
  // ── Economy ──
  'eco.buyTime': {default: 0, options: ['Anytime', 'Round', 'Start', 'Automatic']},
  'eco.creditStart': {default: 3000},
  'eco.creditRound': {default: 1000},
  'eco.creditTurn': {default: 0},
  'eco.creditKill': {default: 500},
  'eco.creditDamage': {default: 1},
  'eco.sellBack': {default: 50},

  // ── Tank ── (kickback / player-size carry engine scalars; index → multiplier)
  'tank.kickback': {default: 2, options: ['Off', 'Low', 'Normal', 'High'], scale: [0, 0.6, 1, 1.5]},
  'tank.size': {default: 1, options: ['Small', 'Normal', 'Large'], scale: [0.72, 1, 1.35]},
  'tank.relTurrets': {default: 0},
  'tank.bury': {default: 0},
  'tank.powerScale': {default: 100},
  'tank.hitpoints': {default: 1000},
  'tank.chatter': {default: 1},
  'tank.colorize': {default: 1},

  // ── Gameplay ──
  'gp.battles': {default: 5},
  'gp.rounds': {default: 10},
  'gp.gameType': {default: 1, options: ['Rounds', 'Deathmatch']},
  'gp.landSize': {default: 0, options: ['1 Screen', '2x', '3x', '4x', '5x']},
  'gp.difficulty': {
    default: 4,
    options: [
      '1. Easiest',
      '2. Very Easy',
      '3. Easy',
      '4. Moderate',
      '5. Fun',
      '6. Challenging',
      '7. Hard',
      '8. Very Hard',
      '9. Mastery',
      '10. Elite',
    ],
  },
  'gp.wind': {default: 2, options: ['Disabled', 'Low', 'Medium', 'High'], scale: [0, 0.5, 1, 1.6]},
  'gp.changeWind': {default: 0, options: ['Per game', 'After round', 'After shot', 'Anytime']},
  'gp.explosionSize': {
    default: 1,
    options: ['Small', 'Normal', 'Large', 'Massive'],
    scale: [0.7, 1, 1.35, 1.8],
  },
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
  'gfx.landType': {default: 5, options: ['Flat', 'Hill', 'Gulley', 'Plateau', 'Slope', 'Random']},
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
  'gfx.framerate': {default: 0, options: ['Off', 'FPS', 'Full']},
  'gfx.fpsCap': {
    default: 0,
    options: ['No Limit', '30 FPS', '60 FPS', '120 FPS', '144 FPS'],
    scale: [0, 30, 60, 120, 144],
  },
  'gfx.demo': {default: 0},

  // ── Audio ── (only the stereo toggle is remembered; volumes/enable live on CAudio)
  'aud.stereo': {default: 1},
} satisfies Record<string, SettingMeta>;

/** The id of any stored setting — the keys of the catalog. A widget or engine getter for an
 *  id not in the catalog is a compile error, so a stray key can't slip in. */
export type SettingId = keyof typeof CATALOG;

/** The catalog, widened so `SETTINGS[id]` reads as {@link SettingMeta} (uniform optional
 *  `options`/`scale`) for a dynamic id — the `satisfies` above still type-checks each entry. */
export const SETTINGS: Record<SettingId, SettingMeta> = CATALOG;
