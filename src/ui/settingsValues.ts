/**
 * Engine-facing view of the persisted option values — each getter returns a value
 * in the units the game wants (fractions, scalars, AI levels), derived from the raw
 * `settingsStore` map. `applyGameSettings` (applySettings.ts) reads these and pushes
 * them into the controller; the UI never lets the engine touch localStorage directly.
 *
 * Defaults here MIRROR the widget defaults in settingsPages.ts — keep them in sync.
 */
import { getVal } from './settingsStore';

// Wind enum (Disabled/Low/Medium/High) → strength scalar; Medium (index 2) = 1.0
// keeps the original feel, Disabled = no wind.
const WIND_SCALE = [0, 0.5, 1, 1.6];

export const gameSettings = {
  /** Credits each player starts a match with. */
  creditStart: (): number => getVal('eco.creditStart', 3000),
  /** Depot sell-back refund as a fraction (0..1). */
  sellRate: (): number => getVal('eco.sellBack', 50) / 100,
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
};
