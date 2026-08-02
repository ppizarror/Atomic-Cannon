/**
 * Engine-facing view of the persisted option values — the raw stored number turned into the
 * units the game wants (fractions, scalars, AI levels).
 *
 * There is ONE reader, {@link engineValue}: an option's kind and units are declared in
 * `settingsCatalog` (a boolean `default` means the engine wants a boolean, a `scale` table means
 * enum→scalar, `map` covers the few that aren't 1:1), so this file no longer restates them as
 * ~50 hand-written getters that could drift from the catalog beside them.
 *
 * `applyGameConfig` (applySettings.ts) drives the ~45 options that mirror a GameConfig field
 * straight off the catalog's `cfg` binding. What's left below is the handful the CONTROLLER or
 * the UI takes instead — they have named setters rather than a config field, so they still need
 * a name here.
 */
import {getVal} from './settingsStore';
import {SETTINGS, type SettingId} from './settingsCatalog';

/**
 * The engine-units value of any stored option, derived entirely from its catalog entry:
 * a boolean-defaulted option reads as a boolean, a `scale`d one maps its stored index through
 * the scalar table (falling back to `scaleDflt` — 1 unless the entry says otherwise — if the
 * index is out of range), and `map` applies any last unit conversion (% → fraction, index → level).
 */
export function engineValue(id: SettingId): number | boolean {
  const meta = SETTINGS[id];
  const raw = getVal(id);
  if (typeof meta.default === 'boolean') return raw !== 0;
  const v = meta.scale ? (meta.scale[raw] ?? meta.scaleDflt ?? 1) : raw;
  return meta.map ? meta.map(v) : v;
}

const num = (id: SettingId): number => engineValue(id) as number;
const bool = (id: SettingId): boolean => engineValue(id) as boolean;

/**
 * The options the CONTROLLER (not GameConfig) owns, plus the two the UI reads directly.
 * Everything else reaches the engine through the catalog's `cfg` binding — see applySettings.
 */
export const gameSettings = {
  /** Credits each player starts a match with. */
  creditStart: (): number => num('eco.creditStart'),
  /** Depot sell-back refund as a fraction (0..1). */
  sellRate: (): number => num('eco.sellBack'),
  /** Credits earned per point of life removed. */
  creditDamage: (): number => num('eco.creditDamage'),
  /** Credits earned per kill (Deathmatch). */
  creditKill: (): number => num('eco.creditKill'),
  /** Credits each survivor earns per turn. */
  creditTurn: (): number => num('eco.creditTurn'),
  /** Credits each survivor earns per round. */
  creditRound: (): number => num('eco.creditRound'),
  /** Battles per match. */
  battles: (): number => num('gp.battles'),
  /** Rounds in a Point/Rounds game. */
  rounds: (): number => num('gp.rounds'),
  /** Game Type enum index → EGameType (0 = Rounds, 1 = Deathmatch). */
  gameType: (): number => num('gp.gameType'),
  /** Per-shot inaccuracy on/off. */
  variance: (): boolean => bool('gp.variance'),
  /** Game-speed multiplier (Update Scale 10 → 1.0 normal). */
  gameSpeed: (): number => num('gp.updateScale'),
  /** Wind strength scalar (0 = disabled). */
  windScale: (): number => num('gp.wind'),
  /** Forced landscape shape 0..4, or -1 for a random landscape ("Random"). */
  landMode: (): number => num('gfx.landType'),
  /** Computer AI level 1..11 (11 = Ultra). */
  difficulty: (): number => num('gp.difficulty'),
  /** Framerate overlay mode: 0 = Off, 1 = FPS only, 2 = Full (FPS + frame count). */
  framerate: (): number => num('gfx.framerate'),
  /** Max framerate cap (ticker.maxFPS): 0 = uncapped (display refresh rate). */
  maxFps: (): number => num('gfx.fpsCap'),
};
