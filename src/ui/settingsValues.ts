/**
 * Engine-facing view of the persisted option values — each getter returns a value in the
 * units the game wants (fractions, scalars, AI levels), derived from the raw `settingsStore`
 * map. `applyGameSettings` (applySettings.ts) reads these and pushes them into the
 * controller; the UI never lets the engine touch localStorage directly.
 *
 * Ids + defaults + enum scalar tables all come from `settingsCatalog` (SETTINGS) — no values
 * are repeated here, so there is nothing to keep in sync with the widgets.
 */
import {getVal} from './settingsStore';
import {SETTINGS, type SettingId} from './settingsCatalog';

/** Engine scalar for an enum setting at its current index (e.g. Wind → wind multiplier),
 *  read from the catalog's co-located `scale` table; `fallback` when there's no entry. */
const scale = (id: SettingId, fallback = 1): number => SETTINGS[id].scale?.[getVal(id)] ?? fallback;

export const gameSettings = {
  /** Credits each player starts a match with. */
  creditStart: (): number => getVal('eco.creditStart'),
  /** Depot sell-back refund as a fraction (0..1). */
  sellRate: (): number => getVal('eco.sellBack') / 100,
  /** Credits earned per point of life removed. */
  creditDamage: (): number => getVal('eco.creditDamage'),
  /** Credits earned per kill (Deathmatch). */
  creditKill: (): number => getVal('eco.creditKill'),
  /** Credits each survivor earns per turn. */
  creditTurn: (): number => getVal('eco.creditTurn'),
  /** Credits each survivor earns per round. */
  creditRound: (): number => getVal('eco.creditRound'),
  /** Battles per match. */
  battles: (): number => getVal('gp.battles'),
  /** Rounds in a Point/Rounds game. */
  rounds: (): number => getVal('gp.rounds'),
  /** Game Type enum index → EGameType (0 = Rounds, 1 = Deathmatch). */
  gameType: (): number => getVal('gp.gameType'),
  /** Land Size: world-width multiplier (enum index 0..4 → 1..5 screens). */
  landSize: (): number => getVal('gp.landSize') + 1,
  /** Per-shot inaccuracy on/off. */
  variance: (): boolean => getVal('gp.variance') !== 0,
  /** Radiation fallout deals damage-over-time to tanks standing on it (on) vs cosmetic-only (off). */
  radiationDamage: (): boolean => getVal('gp.radiationDamage') !== 0,
  /** Game-speed multiplier (Update Scale 10 → 1.0 normal). */
  gameSpeed: (): number => getVal('gp.updateScale') / 10,
  /** Wind strength scalar (0 = disabled). */
  windScale: (): number => scale('gp.wind'),
  /** Forced landscape shape 0..4, or -1 for a random landscape ("Random"). */
  landMode: (): number => {
    const i = getVal('gfx.landType');
    return i >= 0 && i <= 4 ? i : -1;
  },
  /** Computer AI level 1..11 (difficulty enum index 0..10 → level index+1; 11 = Ultra). */
  difficulty: (): number => getVal('gp.difficulty') + 1,

  /** Blast knockback scalar (Off = 0). */
  kickbackScale: (): number => scale('tank.kickback'),
  /** Explosion radius scalar. */
  explosionScale: (): number => scale('gp.explosionSize'),
  /** Shot launch-speed scalar (Power Scale %). */
  powerScale: (): number => getVal('tank.powerScale') / 100,
  /** Tank geometry scalar (Player Size). */
  tankSizeScale: (): number => scale('tank.size'),
  /** Tank starting life. */
  hitpoints: (): number => getVal('tank.hitpoints'),

  drawSmoke: (): boolean => getVal('gfx.smoke') !== 0,
  colorizeTeam: (): boolean => getVal('tank.colorize') !== 0,
  chatter: (): boolean => getVal('tank.chatter') !== 0,
  /** Supply-crate drop chance per turn (0..100 %). */
  crateChance: (): number => getVal('gp.crates'),
  showTeamColor: (): boolean => getVal('gfx.teamColor') !== 0,
  showPowerBars: (): boolean => getVal('gfx.showPower') !== 0,
  showTankStats: (): boolean => getVal('gfx.tankStats') !== 0,
  tracking: (): boolean => getVal('gfx.tracking') !== 0,
  showTurn: (): boolean => getVal('gfx.showTurn') !== 0,
  showPoints: (): boolean => getVal('gfx.showPoints') !== 0,
  autoScroll: (): boolean => getVal('gfx.autoScroll') !== 0,
  showLastAim: (): boolean => getVal('gfx.lastAim') !== 0,
  explosionWaves: (): boolean => getVal('gfx.expWaves') !== 0,
  /** Camera shake on big/nuke blasts (a port embellishment — not in the original). */
  cameraShake: (): boolean => getVal('gfx.camShake') !== 0,
  /** Blow up the non-winning teams as a battle ends (the original's end-of-round wipeout). */
  explodeLosers: (): boolean => getVal('gfx.explodeLosers') !== 0,
  blastCircles: (): boolean => getVal('gfx.blastCircles') !== 0,
  highContrast: (): boolean => getVal('gfx.highContrast') !== 0,
  showAiStats: (): boolean => getVal('gfx.aiStats') !== 0,
  demo: (): boolean => getVal('gfx.demo') !== 0,
  ambientLight: (): boolean => getVal('gfx.ambientLight') !== 0,
  /** Framerate overlay mode: 0 = Off, 1 = FPS only, 2 = Full (FPS + frame count). */
  framerate: (): number => getVal('gfx.framerate'),
  /** Max framerate cap (ticker.maxFPS): 0 = uncapped (display refresh rate). */
  maxFps: (): number => scale('gfx.fpsCap', 0),

  // ── formerly-unwired options (Settings parity) ──
  /** Right-click fires the shot (like Space / the FIRE button). */
  rightClickFires: (): boolean => getVal('gp.rcFires') !== 0,
  /** Depot list uses the smaller bitmap font. */
  smallBuyFonts: (): boolean => getVal('gfx.smallBuy') !== 0,
  /** Turret aim is relative to the tank's terrain tilt (vs. absolute screen angle). */
  relativeTurrets: (): boolean => getVal('tank.relTurrets') !== 0,
  /** Tanks can be buried underground instead of always riding the surface top. */
  buryTanks: (): boolean => getVal('tank.bury') !== 0,
  /** Using a utility item consumes the turn (off = it's free, fire afterwards). */
  utilityTurn: (): boolean => getVal('gp.utilTurn') !== 0,
  /** Shuffle the turn order at the start of each battle. */
  randomizeTurns: (): boolean => getVal('gp.randTurns') !== 0,
  alternateTurns: (): boolean => getVal('gp.altTurns') !== 0,
  /** Buy Time enum: 0 Anytime · 1 After-round · 2 At-start · 3 Automatic. */
  buyTime: (): number => getVal('eco.buyTime'),
  /** Change-Wind cadence enum: 0 Per-game · 1 After-round · 2 After-shot · 3 Anytime. */
  changeWind: (): number => getVal('gp.changeWind'),
  /** Wind model enum: 0 Linear (uniform) · 1 Realistic (boundary-layer altitude profile). */
  windModel: (): number => getVal('gp.windModel'),
  /** Detail render preset: 0 Old School · 1 Simple · 2 High · 3 Wargame. */
  detail: (): number => getVal('gfx.detail'),
  /** Fill blast craters with soil instead of leaving them transparent (background through). */
  craterFill: (): boolean => getVal('gfx.craterFill') !== 0,
};
