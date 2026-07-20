/**
 * Engine-facing view of the persisted option values — each getter returns a value
 * in the units the game wants (fractions, scalars, AI levels), derived from the raw
 * `settingsStore` map. `applyGameSettings` (applySettings.ts) reads these and pushes
 * them into the controller; the UI never lets the engine touch localStorage directly.
 *
 * Defaults here MIRROR the widget defaults in settingsPages.ts — keep them in sync.
 */
import { getVal } from './settingsStore';

// Enum → scalar tables. The default index maps to 1.0 so the out-of-the-box feel
// is the neutral baseline.
const WIND_SCALE = [0, 0.5, 1, 1.6];             // Disabled/Low/Medium(1.0)/High
const KICKBACK_SCALE = [0, 0.6, 1, 1.5];         // Off/Low/Normal(1.0)/High
const EXPLOSION_SCALE = [0.7, 1, 1.35, 1.8];     // Small/Normal(1.0)/Large/Massive
const PLAYER_SIZE_SCALE = [0.72, 1, 1.35];       // Small/Normal(1.0)/Large

export const gameSettings = {
  /** Credits each player starts a match with. */
  creditStart: (): number => getVal('eco.creditStart', 3000),
  /** Depot sell-back refund as a fraction (0..1). */
  sellRate: (): number => getVal('eco.sellBack', 50) / 100,
  /** Credits earned per point of life removed. */
  creditDamage: (): number => getVal('eco.creditDamage', 1),
  /** Credits earned per kill (Deathmatch). */
  creditKill: (): number => getVal('eco.creditKill', 500),
  /** Credits each survivor earns per turn. */
  creditTurn: (): number => getVal('eco.creditTurn', 0),
  /** Credits each survivor earns per round. */
  creditRound: (): number => getVal('eco.creditRound', 1000),
  /** Battles per match. */
  battles: (): number => getVal('gp.battles', 5),
  /** Per-shot inaccuracy on/off. */
  variance: (): boolean => getVal('gp.variance', 1) !== 0,
  /** Game-speed multiplier (Update Scale 10 → 1.0 normal). */
  gameSpeed: (): number => getVal('gp.updateScale', 10) / 10,
  /** Wind strength scalar (0 = disabled). */
  windScale: (): number => WIND_SCALE[getVal('gp.wind', 2)] ?? 1,
  /** Forced landscape shape 0..4, or -1 for a random landscape ("Random"). */
  landMode: (): number => {
    const i = getVal('gfx.landType', 5);
    return i >= 0 && i <= 4 ? i : -1;
  },
  /** Computer AI level 1..10 (difficulty enum index 0..9 → level index+1). */
  difficulty: (): number => getVal('gp.difficulty', 4) + 1,

  /** Blast knockback scalar (Off = 0). */
  kickbackScale: (): number => KICKBACK_SCALE[getVal('tank.kickback', 2)] ?? 1,
  /** Explosion radius scalar. */
  explosionScale: (): number => EXPLOSION_SCALE[getVal('gp.explosionSize', 1)] ?? 1,
  /** Shot launch-speed scalar (Power Scale %). */
  powerScale: (): number => getVal('tank.powerScale', 100) / 100,
  /** Tank geometry scalar (Player Size). */
  tankSizeScale: (): number => PLAYER_SIZE_SCALE[getVal('tank.size', 1)] ?? 1,
  /** Tank starting life. */
  hitpoints: (): number => getVal('tank.hitpoints', 1000),

  drawSmoke: (): boolean => getVal('gfx.smoke', 1) !== 0,
  colorizeTeam: (): boolean => getVal('tank.colorize', 1) !== 0,
  showTeamColor: (): boolean => getVal('gfx.teamColor', 1) !== 0,
  showPowerBars: (): boolean => getVal('gfx.showPower', 1) !== 0,
  showTankStats: (): boolean => getVal('gfx.tankStats', 0) !== 0,
  tracking: (): boolean => getVal('gfx.tracking', 1) !== 0,
  showTurn: (): boolean => getVal('gfx.showTurn', 1) !== 0,
  showLastAim: (): boolean => getVal('gfx.lastAim', 1) !== 0,
  explosionWaves: (): boolean => getVal('gfx.expWaves', 1) !== 0,
};
