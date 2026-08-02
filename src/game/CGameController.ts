/**
 * CGameController - Main Game Controller
 *
 * Central coordinator for:
 * - Turn-based battle flow state machine
 * - Tank management and player turns
 * - Firing sequence coordination
 * - Wind and physics parameters
 */

import {strings, fmt} from '../i18n';
import {CLand} from '../core/CLand';
import {CTank, TEAM_COLORS, DEFAULT_TEAM_COLOR, PLAYER_TANKS} from '../core/CTank';
import {Roster, ROSTER_HUMAN_SLOTS} from '../core/CRoster';
import type {StatsDelta} from '../net/stats';
import {CShot, REF_TIME_SCALE} from '../core/CShot';
import {windProfile, gustFactor} from '../core/wind';
import {GameConfig, isWargame} from '../core/CGameConfig';
import {pickTaunt, type TauntCategory} from '../core/CTaunts';
import {landEnabled, weaponEnabled} from '../core/CGameContent';
import {
  BIG_BLAST_RADIUS,
  CWeapon,
  getDefaultWeaponIndex,
  getWeapon,
  WEAPON_DATABASE,
  type WeaponDef,
} from '../core/CWeapon';
import {Vec2} from '../math/Vec2';
import {CParticleSystem, type ISmokeSink} from '../core/CParticleSystem';
import {ScreenShake} from '../core/rendering/ScreenShake';
import {RenderGate} from './RenderGate';
import {CWeather} from '../core/CWeather';
import {
  CEconomy,
  START_CREDITS,
  SELL_REFUND,
  CREDIT_PER_DAMAGE,
  CREDIT_PER_KILL,
  CREDIT_PER_TURN,
  CREDIT_PER_ROUND,
} from '../core/CEconomy';
import {
  AI_DEFAULT_LEVEL,
  AI_LEVEL_ULTRA,
  aimProbability,
  angleError,
  bestAim,
  BOT_UTILITY_EXT,
  chooseBotWeapon,
  isBotSelfBuff,
  moveWeaponIndices,
  pickMoveWeapon,
  pickTarget,
  simulateShot,
} from '../core/CBotAI';
import {
  NO_THREAT,
  planUltraTurn,
  rangePowerCorrection,
  SELF_BURY_MIN_EARTH,
  ULTRA_PERSONALITIES,
  ULTRA_PERSONALITY_NAMES,
  type UltraAlly,
  type UltraCtx,
  type UltraThreat,
  type UltraWeapon,
  type UltraWeights,
} from '../core/CBotUltraAI';
import {CAssetManager} from '../core/rendering/CAssetManager';
import {getFont, type FontId} from '../core/rendering/BitmapFont';
import {clamp, clamp01, deg2rad, rad2deg, TWO_PI, wrapIndex} from '../math/num';
import {plusMinus} from '../math/random';
import {Prng} from '../math/prng';
import type {GameCommand} from '../net/commands';
import type {MatchConfig} from '../net/protocol';
import {
  EXT,
  isBeamExt,
  type ExtType,
  type ShotWorld,
  firedIntoTerrain,
  weaponDetonate,
  weaponFlyStep,
} from '../core/weapons/WeaponBehavior';
import {EXP, type ExpType, isNukeExp} from '../core/weapons/ExpType';
import {CAudio} from '../audio/CAudio';
import landData from '../data/land.json';
import {hexToRgb} from '../math/color';

/**
 * Game state machine states
 */
export enum EGameState {
  Battle = 'battle',
  Flying = 'flying',
  ShotFlying = 'shot_flying',
  Explosion = 'explosion',
  BattleEnd = 'battle_end',
}

/** Match type. Deathmatch pays a per-kill bounty; Rounds (Point) scores by damage. */
export enum EGameType {
  Rounds = 0,
  Deathmatch = 1,
  FastTest = 2,
}

/** One team's Battle Heroes submission: the callsign plus both board values (kills for
 *  Deathmatch, average damage-per-tank "score" for Points games). */
export interface BattleHeroTeam {
  name: string;
  score: number;
  kills: number;
}

/** One team's row in the between-battles standings table. */
export interface WarTeamRow {
  name: string;
  color: string;
  kills: number;
  deaths: number;
  points: number; // Rounds/Points mode: team total net damage dealt (the "Points" column)
  lifePct: number;
  accuracyPct: number;
  damagePerHit: number;
  isLeader: boolean;
  isHuman: boolean;
}

/** The full between-battles "winning the war" standings, computed at battle end. */
export interface WarStandings {
  title: string; // "X is winning the war." / "X wins the war!" / "X wins the battle!"
  banner: string; // war-end only: "Victory!" / "Defeat!" / "All tanks are dead!" / ""
  subtitle: string[]; // ["The War is not over yet.", "Battle N of M completed."]
  winCondition: string; // "The team with the most kills or life wins." (Deathmatch)
  rows: WarTeamRow[]; // per-team, leader first
  pointsMode: boolean; // Rounds/Points → "Points" column instead of Kills/Deaths
  prompt: string; // "Click anywhere to play next battle." / "…exit to menu."
  warOver: boolean;
}

/** The running per-match play tallies the global-stat deltas are differenced from (`sec` is the
 *  match's elapsed play time; the rest mirror the same-named StatsDelta fields). */
interface MatchStatTally {
  weaponsFired: number;
  shotsFired: number;
  tanksDestroyed: number;
  damageDealt: number;
  nukesFired: number;
  terrainCarved: number;
  creditsSpent: number;
  sec: number;
}

const freshStatTally = (): MatchStatTally => ({
  weaponsFired: 0,
  shotsFired: 0,
  tanksDestroyed: 0,
  damageDealt: 0,
  nukesFired: 0,
  terrainCarved: 0,
  creditsSpent: 0,
  sec: 0,
});

/** The units of progress a stats flush CLOSES — stamped onto the drained delta (see takeStatsDelta).
 *  A plain `{}` flush (quitting to the menu, leaving the page) banks the play with no progress. */
export interface StatsFlush {
  battles?: number; // battles completed by this flush
  warOver?: boolean; // this flush closes the war (the fireworks) → counts as one finished war
}

interface LandConfig {
  bg: string;
  ambient: string; // hand-picked mood tint (#rrggbb) for Ambient Lighting — soft-light over the scene
  weather: {type: string; intensity: number}[];
  layers: {tile: string; depth: number}[];
}

const LAND_DATA = landData as LandConfig[];

// TEMPORARY (explosion-FX testing): lock the weapon selection to one control
// weapon so it can be spammed to review effects. Set to null to restore the
// full arsenal.
const CONTROL_WEAPON: string | null = null;

// A beam holds on screen for ~this long, then the earth collapses (the removed dirt
// falls/settles over the following ~second). Keep it just under the beam's on-screen
// life so the ground drops as the ray fades — "beam holds → earth falls".
const BEAM_COLLAPSE_DELAY = 1;

// Minimum rocket motor burn (seconds from launch). Fume/flare emit for max(this, time-to-apex):
// arced shots keep the authentic apex cutoff, but downward/flat shots — which never ascend — still
// get an initial exhaust plume instead of nothing.
const ROCKET_MIN_BURN = 0.7;

// Gravity (px/s²) a deployed mine falls under when the ground beneath it is carved away — so a mine
// left floating over a fresh hole drops onto the new surface instead of hanging in mid-air. Mirrors
// the tank fall in CTank.update().
const MINE_GRAVITY = 400;

// Safety ceiling on live tracer ranging pins (they clear on the next shot; this only
// bounds a single turn's repeated tracer volleys). Well above any one volley's count.
const MAX_AIM_MARKERS = 16;

// Bunker/Wall structure draw scale (× Player Size). The original scales the structure
// bitmap down rather than stamping it at native size; this reads proportionate to the tank
// (bunker.bmp 40×118 → ~18×53, wall.bmp 30×200 → ~14×90 — a barrier a tank hides behind).
const STRUCTURE_SCALE = 0.45;

const controlWeaponIndex = (): number =>
  CONTROL_WEAPON ? WEAPON_DATABASE.findIndex(w => w.id === CONTROL_WEAPON) : -1;

// Sentry turrets ONE player (team) may hold on the field at a time, past which deploySentry
// no-ops. Deliberately per-player rather than a shared field budget: a single pool lets the first
// deployer starve everyone else, and it shrinks per head as the match grows (at 16 players a pool
// of 8 is under one each), so every player gets the same allowance whatever the roster size. Some
// ceiling is still needed — a sentry weapon under free-fire has unlimited ammo, so an ungated
// deploy would grow the field every turn. Sentries are cleared at the start of each battle.
const MAX_SENTRIES_PER_PLAYER = 8;
// The weapon a deployed sentry fires on its turn: the plain Shell (Turret variant) or the
// rapid Machine Gun (Minigun variant). The Turret uses the Shell staple; the Minigun looks
// the Machine Gun up by its STABLE id (never the localised display name) — falling back to
// the Shell if the Machine Gun is disabled/absent.
const sentryMachineGunIndex = (): number => {
  const i = WEAPON_DATABASE.findIndex(w => w.id === 'machine.gun');
  return i >= 0 ? i : getDefaultWeaponIndex();
};
// A sentry fires at full power (POWER_MAX) in a direct line — no ballistic solve.
const SENTRY_FIRE_POWER = 1000;

// The deployed Sentry's own hull art. Same naming CTank.getRequiredSprites builds, but a Sentry
// only exists once one is deployed, so startGame preloads these by name to keep the first turret
// from popping in as a vector-hull placeholder.
const SENTRY_SPRITES = ['body', 'wreck', 'turret'].map(part => ({
  name: `tanks/Sentry ${part}`,
  file: `/assets/tanks/Sentry ${part}.bmp`,
}));

// Opening angle + power drawn per tank at each battle start (the original's ranges). The angle
// spans the whole upward half-circle — 0 = flat right, 90 = straight up, 180 = flat left; the
// below-horizon half (181..359) is excluded, since a tank would open the battle pointing into dirt.
const START_AIM_MIN = 0;
const START_AIM_MAX = 180;
const START_POWER_MIN = 200;
const START_POWER_MAX = 699;

// DEATH-class weapon indices (Six Under, Burial Mound, Cremation, Ashes, Toxic Grave), in database
// order. When a tank is destroyed while it still OWNS one of these, the FIRST is detonated on the
// corpse (posthumous "cook-off"). Memoised — the database is immutable after load.
let g_deathWeaponIndices: number[] | null = null;
function deathWeaponIndices(): number[] {
  if (!g_deathWeaponIndices) {
    g_deathWeaponIndices = [];
    for (let i = 0; i < WEAPON_DATABASE.length; i++)
      if (getWeapon(i).getExtType() === EXT.DEATH) g_deathWeaponIndices.push(i);
  }
  return g_deathWeaponIndices;
}

// Min seconds between live-aim relays to spectators in a net match (~16/s) — smooth turret
// tracking without flooding the socket on a fast angle/power drag.
const NET_AIM_INTERVAL = 0.06;

// A bot restocks a shield only when its current shield is below this (the original's autobuy
// shield-need threshold wasn't recovered; ~half the 1000 cap is the best reading).
const BOT_SHIELD_NEED = 500;

// Succession bursts louder than this `sucSec` (reference units) re-bark their report +
// muzzle flash on each salvo; faster bursts (cannon/shotgun ≈ 0.1) fire near-instantly
// and stay silent after the opener. Matches the original's `0.5 < sucSec` FX gate.
const SUCCESSION_LOUD_MAX_SEC = 0.5;

// Blast knockback: base impulse (px/s) for a reference-size blast at full damage, and the
// radius that maps to ×1. The original scales the kick by the per-explosion size (not damage
// alone), so a bigger crater shoves harder for equal life removed — a nuke launches a tank a
// shell only nudges. The size factor is clamped so bullets still barely budge and nukes don't
// fling absurdly.
const KICK_BASE = 240;
const KICK_REF_RADIUS = 50;
const KICK_SIZE_MIN = 0.3;
const KICK_SIZE_MAX = 3.5;

// Camera pan speed (world px/sec) — the constant-speed ease toward the follow
// target (the original scrolls at dt·gameSpeed·scrollSpeed; this is that budget
// in px/sec). Fast enough to keep a shot roughly framed without whipping.
const CAMERA_SCROLL_SPEED = 1100;
// Where the followed object sits in the view: 0.5 = dead centre.
const CAMERA_CENTER = 0.5;
// Graphics → Camera: how the view moves to the next player when the turn hands off. Matches the
// gfx.camera enum order (0 Smooth — the implicit default, just ease across / 1 Instant / 2 Cinematic).
const CAM_INSTANT = 1;
const CAM_CINEMATIC = 2;
const CAM_DWELL_SEC = 0.8; // Cinematic: how long the camera lingers on the impact before it pans away

// "Show Points" floating damage numbers: life (s) and rise distance over that life
// (px). Spawn jitter (px) matches the original (±20 / ±12).
const DMG_NUM_LIFE = 1.1;
const DMG_NUM_RISE = 28;
// "Show Blast Circles": how long each explosion ring lingers (s).
const BLAST_CIRCLE_LIFE = 1.4;

// Taunt speech bubbles (Tank → Chatter). A bubble stays up TAUNT_LIFE seconds and
// fades over its last TAUNT_FADE. Trigger chances match the original percent gate:
// 8% post-fire, 30% on death, 60% on the idle interval. The idle timer re-arms to a
// random gap in [TAUNT_IDLE_MIN, TAUNT_IDLE_MAX] seconds each turn/attempt.
const TAUNT_LIFE = 4.0;
const TAUNT_FADE = 0.6;
const TAUNT_CHANCE_POSTFIRE = 8;
const TAUNT_CHANCE_DEATH = 30;
const TAUNT_CHANCE_IDLE = 60;
// Own goal: a tank that drops a round on itself or its own squad occasionally has a word for itself.
const TAUNT_CHANCE_SELF = 35;
const SELF_TAUNT_MIN_DAMAGE = 20; // a graze isn't worth a line — it has to have actually hurt
const TAUNT_IDLE_MIN = 7;
const TAUNT_IDLE_MAX = 15;
// Screen-space height (px) the bubble's tail floats above the tank's centre — just
// clear of the turret so the tail points right at the tank.
const TAUNT_RISE = 20;

// Victory fireworks (war-end Victory only). A burst appears at a random sky point on a
// randomized interval; it's one of the 8 `bursts/*.bmp` shapes (circle/ring/star/delta/…),
// emitting one spark per lit pixel — coloured by that pixel — that flies radially outward
// then arcs down under gravity + wind and fades. The shape is visible at t=0, then rains
// down. Speed is uniform (rand01 × scale), so many sparks barely move and hold the shape
// while a few fly out; positions are at native bmp scale (the wide look comes from the
// expansion, not upscaling); alpha holds full for the first 60% of life then falls
// linearly to 0. Particle life is kept short so sparks fade in air on the fixed camera.
const FW_LIFE = 2.8; // particle lifetime (s)
const FW_SPEED = 52; // radial launch speed scale (px/s); per-spark speed = rand01 × this
const FW_GRAVITY = 95; // downward accel (px/s²) — the burst rains down (semi-implicit Euler, no drag)
const FW_SCALE = 1; // native bmp scale (no position multiplier)
const FW_HOLD = 0.6; // fraction of life at full alpha before the linear fade begins
const FW_INTERVAL_MIN = 0.12; // gap between bursts ≈ uniform(0, max)
const FW_INTERVAL_MAX = 2.4;
// Launch trail (a deliberate embellishment over the legacy, which just pops the burst
// in): a rocket rises from the ground trailing sparks, then detonates into the burst.
const FW_ROCKET_SPEED = 320; // rocket rise speed (px/s)
const FW_TRAIL_LIFE = 0.4; // launch-trail spark lifetime (s)
// The 8 shape templates (bursts/<name>.bmp). Loaded + sampled once into `burstPixels`.
const BURST_NAMES = ['circle', 'ring', 'star1', 'star2', 'delta', 'pentagon', 'hexagon', 'octagon'];
// Per-shape sampled lit pixels: offset from the sprite centre + that pixel's colour.
// null until the bmp loads; filled asynchronously by loadBurstPixels().
const burstPixels: ({dx: number; dy: number; color: string}[] | null)[] = BURST_NAMES.map(
  () => null,
);
let burstLoadStarted = false;

/** Load the 8 burst bmps once and sample their lit pixels (magenta keyed out, ~half
 *  subsampled for particle count) into `burstPixels`. Browser-only (uses Image/canvas). */
function loadBurstPixels(): void {
  if (burstLoadStarted || typeof document === 'undefined') return;
  burstLoadStarted = true;
  BURST_NAMES.forEach((name, idx) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const g = cv.getContext('2d', {willReadFrequently: true})!;
      g.drawImage(img, 0, 0);
      const {data} = g.getImageData(0, 0, img.width, img.height);
      const hw = img.width / 2,
        hh = img.height / 2;
      const pts: {dx: number; dy: number; color: string}[] = [];
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4; // sample every lit pixel — many fine sparks
          const r = data[i],
            gg = data[i + 1],
            b = data[i + 2];
          if (r > 200 && gg < 80 && b > 200) continue; // magenta colour-key
          if (r + gg + b < 30) continue; // (near-)black background
          pts.push({dx: x - hw, dy: y - hh, color: `rgb(${r},${gg},${b})`});
        }
      }
      burstPixels[idx] = pts;
    };
    img.src = `/assets/bursts/${name}.bmp`;
  });
}

/** One firework spark: world position + velocity, its (bmp-pixel) colour, and age/life. */
interface Firework {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  age: number;
  life: number;
}

/** A rising launch rocket: climbs from `y` (the ground) to `targetY`, trailing sparks,
 *  then detonates into a burst at (x, targetY). */
interface FwRocket {
  x: number;
  y: number;
  vy: number;
  targetY: number;
}

// Supply crates (Gameplay → Crates). On a per-ROUND chance a parachute crate drops from
// the top of the map, descends at a constant speed with a ±5° pendulum wobble, lands on
// the terrain, and is collected by any tank that comes within reach — granting credits,
// health, or a weapon. Descent speed, wobble, and the contents split match the original.
const CRATE_DESCENT = 90; // constant chute descent speed (px/s)
// Sideways drift per unit of wind for a descending parachute crate (px/s), Realistic mode only.
// High vs the descent speed because a chute is nearly all sail — at full wind (±5) it drifts ~±70 px/s
// against a 90 px/s fall, a clear ~38° slant. Eased near the ground by the wind altitude profile.
const CRATE_WIND_DRIFT = 14;
const CRATE_GRAVITY = 95; // free-fall accel if the chute ever detaches (px/s²)
const CRATE_WOBBLE_DEG = 5; // pendulum amplitude (±deg), pivot at the canopy top
const CRATE_WOBBLE_SPEED = 200; // deg/s of the sine argument (≈1.8 s per swing)
const CRATE_BOX = 32; // landed crate size (px); the pickup reach is CRATE_BOX/2 + tank radius
const FLOAT_TEXT_LIFE = 2.0; // crate-pickup message lifetime (s)

type CrateKind = 'weapon' | 'credits' | 'health' | 'bomb';

/** A supply crate falling under (then landed without) a parachute. `y` is the crate box's
 *  position; the parachute assembly is drawn above it and swings about its canopy top. */
interface Crate {
  x: number;
  y: number;
  vy: number; // free-fall velocity if the chute ever detaches (normally 0)
  kind: CrateKind;
  amount: number; // credits / health payload
  weaponIndex: number; // weapon type (weapon / bomb kinds)
  landed: boolean;
  phase: number; // wobble phase offset (deg) so crates don't swing in unison
  id: number;
}

/** A short-lived floating pickup message (e.g. "You found 400 credits.") above a tank. */
interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

/** A live speech bubble: the speaker (for its screen position) + the rendered
 *  "Name: line" text + its age. Kept controller-side (not on the tank) so a death
 *  bubble outlives its now-dead speaker. */
interface TauntBubble {
  id: number;
  speaker: CTank;
  text: string;
  age: number;
}

/** A taunt bubble projected for the DOM overlay: fractional screen position (0..1 of
 *  the view) so it tracks the camera, plus a fade alpha. */
export interface ActiveTaunt {
  id: number;
  text: string;
  xPct: number;
  yPct: number;
  alpha: number;
}

/**
 * The world simulates at a FIXED logical resolution and the compositor stretches that scene
 * to each display. NET_VIEW_H is the shared DESIGN HEIGHT for BOTH solo and net, so tank +
 * terrain sizes stay consistent on every window (a big monitor doesn't shrink them). Solo
 * derives its logical WIDTH from the display aspect; a net match forces NET_VIEW_W so every
 * client builds a byte-identical world regardless of window size or local settings.
 */
const NET_VIEW_W = 1280;
const NET_VIEW_H = 720;
const NET_LAND_SCALE = 2; // default net world width until the host picks a map size

/** Authoritative per-turn state shared between clients in a network match. */
export interface NetSnapshot {
  tanks: {
    x: number;
    y: number;
    life: number;
    shield: number;
    armor: number;
    hazmat: number;
    credits: number;
    /** Explicit alive flag — a Rounds/Points tank sits at 0 life yet ALIVE, so a bootstrapping
     *  client must NOT re-derive alive from life (that would wrongly kill 0-life tanks). */
    alive: boolean;
  }[];
  /** Full terrain heightmap (per-column surface Y). */
  heights: number[];
  wind: {x: number; y: number};
  /** The seeded gameplay-RNG cursor at this snapshot. `stateHash` mixes the cursor, and shots draw
   *  from it (kickback, crate rolls, variance jitter), so a client that bootstraps from a snapshot
   *  MUST restore it — otherwise it starts a fraction out of phase with the room and both desyncs
   *  its own next shot AND false-flags a lockstep divergence. Restored in {@link applyNetSnapshot}. */
  rngState: number;
  /** Deployed mines — authoritative so a reconnecting/keyframe client reproduces them exactly:
   *  position, arm countdown, weapon, and owner-BY-INDEX (a tank ref can't cross the wire; -1 = none)
   *  for kill attribution. `stateHash` mixes them so mine drift is DETECTED. Optional for back-compat
   *  with older snapshots (absent → mines left untouched). */
  mines?: {x: number; y: number; armed: number; weaponIndex: number; ownerIdx: number}[];
  /** Supply crates on the field — authoritative so a client reproduces them exactly. Crate physics
   *  free-runs on wall-clock frames outside the lockstep shot window, so crates are NOT in `stateHash`;
   *  instead every keyframe re-pins them (see reconcileNetCrates). Optional for back-compat. */
  crates?: {
    x: number;
    y: number;
    vy: number;
    kind: string; // one of CrateKind; validated/narrowed on adopt (matches the wire ShotResult type)
    amount: number;
    weaponIndex: number;
    landed: boolean;
  }[];
}

/**
 * CGameController - Main game controller
 */
export class CGameController implements ShotWorld {
  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================

  constructor(canvas: HTMLCanvasElement) {
    this.m_ctx = canvas.getContext('2d')!;
    this.m_viewW = canvas.width; // logical view size (solo default = boot window size)
    this.m_viewH = canvas.height;
    this.m_displayW = canvas.width; // live native display size (main keeps it current)
    this.m_displayH = canvas.height;

    // Large maps: the WORLD can be several viewports wide (Land Size); the scene
    // canvas is the VIEW. World width = viewWidth × landScale (1 = no scroll);
    // world height = view height (scroll is horizontal only). `m_camX` is the
    // world X of the view's left edge.
    this.m_worldWidth = Math.round(canvas.width * this.landScale());
    // Publish the world scale so shot PHYSICS grow with the map (a full-power shot stays powerful on
    // big maps instead of only crossing a fraction of them). Blast SIZE is a separate resolution axis.
    GameConfig.worldScale = this.m_worldWidth / canvas.width;
    GameConfig.viewWidth = canvas.width; // resolution-normalise launchSpeed (see CShot.LAUNCH_REF_WIDTH)

    // Terrain fills the full world so its body covers the bottom of the screen —
    // the background's foreground never shows in the HUD strip.
    this.m_land = new CLand(this.m_worldWidth, canvas.height);

    this.m_tanks = [];
    this.m_shots = [];
    this.m_particles = new CParticleSystem();
    this.m_particles.setBounds(this.m_worldWidth, canvas.height);
    // Surface provider (reads the CURRENT land each call, so it survives land rebuilds): drives the
    // wind altitude profile and keeps crater-vent fumes from spraying into empty sky (no soil).
    this.m_particles.setGroundProvider(x => this.m_land.getHeightAt(Math.floor(x)));
    // Radiation heat haze: the land decides where the fallout fumes, the particle system owns the
    // resulting particles (it used to run its own pool inside CLand).
    this.m_land.setFxSink(this.m_particles);
    // Weather fills the VIEW (rain/snow are screen-space), not the world.
    this.m_weather = new CWeather(canvas.width, canvas.height);
    this.m_economy = new CEconomy();
    this.m_screenShake = new ScreenShake();
    this.m_assets = new CAssetManager();

    // Initialize weapon list (index into WEAPON_DATABASE). The control-weapon
    // override (if set) forces the FX-test weapon.
    this.m_currentWeaponIndex =
      controlWeaponIndex() >= 0 ? controlWeaponIndex() : getDefaultWeaponIndex();

    // Wind: positive = right, negative = left
    this.m_wind = new Vec2(0, 0);

    // UI control values
    this.m_angle = 45;
    this.m_power = 500;
  }

  /** Start a match with `nPlayers` teams; each team fields `m_tanksPerTeam` tanks (a
   *  squad sharing that player's colour). Every configured tank spawns — the Play menu's
   *  own limits (16 players × 5 tanks) are the only bound. The first `m_humanCount` teams
   *  are human. */
  startGame(nPlayers: number = 2): void {
    this.m_started = true; // a battle now exists — the per-frame sim/render/HUD work is live
    // A plain startGame (solo / Play) is never a network match — clear any net state
    // left from a previous online game. startNetworkGame sets m_bootingNet to keep its
    // own config through this reset.
    if (!this.m_bootingNet) {
      this.m_netMode = false;
      this.m_netLocalIndex = -1;
      this.m_terrainSeed = null;
      this.m_netRoster = null;
      this.m_onNetTurnEnd = null;
      this.m_onNetCommand = null; // clear the solo→net relay too (sibling of m_onNetTurnEnd)
      // Restart the battle-progress counters for a fresh SOLO war. nextBattle maintains them WITHIN a
      // war, but a NEW match must reset them — else the 2nd+ war in a session inherits the previous
      // war's end values: a Deathmatch would end after one battle (getWarOver: currentBattle>=total),
      // a Rounds match after one round (endTurn: currentRound>total), and the round-1 forced bot aim
      // (currentRound===1) would never fire. (The net path sets currentBattle itself; see startNetworkGame.)
      this.m_currentBattle = 1;
      this.m_currentRound = 1;
    }
    // "Shot N" HUD counter: reset on a FRESH match (battle 1 — solo, or a brand-new net match), but NOT
    // on a net reconnect resuming battle N>1, so it keeps counting in step with the peers who never left.
    if (this.m_currentBattle <= 1) this.m_shotsFired = 0;

    // Fix the LOGICAL world/view size for this match. Everything (heightmap length, tank
    // sizes, physics) lives in these coordinates; the compositor presents the logical scene
    // to the live display. Solo captures THIS display's size at start, so the world renders
    // 1:1 (crisp) — a later window resize only stretches the present, it never rebuilds. A
    // net match uses the HOST's size (m_netViewW/H) so every client builds the same-length
    // heightmap; the host renders it 1:1, other players stretch it to their own window.
    this.m_viewW = this.m_netMode ? this.m_netViewW : this.m_displayW;
    this.m_viewH = this.m_netMode ? this.m_netViewH : this.m_displayH;
    // Resolution-normalise shot physics: launchSpeed scales by √(viewWidth/REF) so max power crosses
    // the world on any display (net uses the shared host width → identical lockstep on every client).
    GameConfig.viewWidth = this.m_viewW;

    // Rounds/Point mode is NON-LETHAL (faithful to the original): a tank at 0 life is never marked
    // destroyed and keeps taking turns — the round is scored by damage points, not eliminations.
    // Only Deathmatch destroys tanks. CTank.hit()/applyRadiationDamage read this.
    GameConfig.lethalDamage = this.m_gameType === EGameType.Deathmatch;

    // Reset state
    this.m_simAccum = 0; // fresh fixed-timestep accumulator
    this.stopMovementAudio(); // silence any tank-drive / jet loop from a match restarted mid-drive
    this.m_netShotResolving = false;
    this.m_pendingSalvos = 0; // a fresh match has no succession salvos queued (a burst interrupted by
    // Quit→menu freezes the sim mid-count; without this reset the stale value would wedge the first
    // ShotFlying-entering shot that doesn't reassign it — a Death round — in ShotFlying forever)
    this.m_tanks = [];
    this.m_shots = [];
    this.m_ghostShots = [];
    this.m_mines = [];
    this.m_aimMarkers = [];
    this.m_damageNumbers = [];
    this.m_blastCircles = [];
    this.m_crates = [];
    this.m_floatTexts = [];
    this.m_bubbles = [];
    this.m_fireworks = [];
    this.m_rockets = [];
    this.m_showFireworks = false;
    // Drop any deferred actions queued by the PREVIOUS match — e.g. a still-running Explode-Losers
    // cascade or a queued bot turn. m_time is monotonic (never reset), so a leftover closure whose
    // `at` is already in the past would otherwise all fire at once on this match's first update().
    this.m_timers = [];
    this.m_netAimDirty = false;
    this.m_lastImpactX = 0; // fresh camera focus (no stale prior-match impact)
    this.m_camDwell = 0; // no Cinematic dwell carried across matches
    this.m_impactThisTurn = false; // no carried-over "a blast landed" flag
    // Fresh per-match stat tally (and its upload baseline — nothing of this match is banked yet).
    this.m_stats = {
      weaponsFired: 0,
      shotsFired: 0,
      nukesFired: 0,
      tanksDestroyed: 0,
      terrainCarved: 0,
      creditsSpent: 0,
    };
    this.m_statsBase = freshStatTally();
    this.m_matchStartTime = this.m_time;

    // Land Size (Play menu): the world may be several viewports wide. Rebuild the
    // land + bounds if the size changed since the last match.
    const worldW = Math.round(this.m_viewW * this.landScale());
    if (worldW !== this.m_worldWidth) {
      this.m_worldWidth = worldW;
      GameConfig.worldScale = worldW / this.m_viewW;
      this.m_land.dispose(); // free the old world buffers first → no transient double-footprint
      this.m_land = new CLand(worldW, this.m_viewH);
      this.m_particles.setBounds(worldW, this.m_viewH);
    }

    // Seed the gameplay RNG from the match seed (shared in a network match → identical
    // outcomes on every client; a fresh seed keeps solo play random). Derived from the
    // terrain seed so gameplay draws don't mirror the terrain generator's own stream.
    const rngSeed = ((this.m_terrainSeed ?? Date.now()) ^ 0x9e3779b9) >>> 0;
    this.m_rng.seed(rngSeed);

    this.generateTerrain();

    // Build the spawn list from the roster (Customize Players): one entry per tank.
    // Each player fields `m_tanksPerTeam` tanks that share the player's colour — colour
    // is the team identity, so a squad is a team (distinct player colours → free-for-all).
    const roster = Roster.players;
    const teamOfColor = new Map<string, number>();
    const perTeam = Math.max(1, this.m_tanksPerTeam);
    this.m_teamNames.clear(); // fresh match — the previous roster's team labels are gone

    const playerNames = strings.value.playerNames;
    // Roster layout (Customize Players): the first ROSTER_HUMAN_SLOTS entries are the HUMAN pool, the
    // rest the BOT pool (the editor's two sections). A local match with H humans + C CPUs draws humans
    // from 0..H-1 and bots from the bot pool, so editing "Bot 1" configures the CPU you actually face.
    // (Network matches use the lobby roster in turn order — no split.)
    const BOT_POOL_START = ROSTER_HUMAN_SLOTS;
    const spawns: {name: string; color: string; model: string; team: number; human: boolean}[] = [];
    for (let p = 0; p < nPlayers; p++) {
      // In a network match the roster comes from the lobby (same on every client, in
      // turn order) so names/colours — and thus team identity — match across clients.
      const netCfg = this.m_netRoster?.[p];
      const human = p < this.m_humanCount;
      // Local roster index: humans map straight through; CPUs draw from the bot pool (slot 8+).
      const rosterIdx = human ? p : BOT_POOL_START + (p - this.m_humanCount);
      const cfg = netCfg
        ? // Pick the hull sprite deterministically from the shared seed + slot so every client
          // shows the same tank (the local default is Math.random → each client differs). Purely
          // cosmetic — collision comes from tankSizeScale, not the model — so it isn't hashed.
          {
            name: netCfg.name,
            model:
              PLAYER_TANKS[
                (((this.m_terrainSeed ?? 0) ^ (p * 0x9e3779b9)) >>> 0) % PLAYER_TANKS.length
              ],
            color: netCfg.color,
          }
        : (roster[rosterIdx] ?? {
            name:
              rosterIdx === 0
                ? strings.value.game.defaultPlayer
                : playerNames[(rosterIdx - 1) % playerNames.length],
            model: '',
            color: TEAM_COLORS[rosterIdx] ?? DEFAULT_TEAM_COLOR,
          });
      // Team = the colour's group; the first tank of a colour defines a new team id.
      let team = teamOfColor.get(cfg.color);
      if (team === undefined) {
        team = teamOfColor.size;
        teamOfColor.set(cfg.color, team);
      }
      // Humans (and network players) keep their roster/lobby name from the human pool;
      // local CPU opponents are named from the separate bot pool instead. The Wargame
      // Detail preset overrides every CPU to "Whopper" (the WarGames reference).
      // Every slot — human OR computer — keeps its Customize Players roster name, so CPU
      // opponents are nameable (faithful to the original: names come from the roster, and a
      // slot is a bot purely because it falls beyond the human count). The Wargame Detail
      // preset still overrides every CPU to "Whopper" (the WarGames reference).
      let baseName: string;
      if (netCfg || human) baseName = cfg.name;
      else if (isWargame()) baseName = strings.value.game.whopper;
      else baseName = cfg.name;
      // The team's own label for the status overlay: the bare player name, no squad suffix. First
      // slot of a colour wins, mirroring how that slot's colour defined the team above.
      if (!this.m_teamNames.has(team)) this.m_teamNames.set(team, baseName);
      for (let k = 0; k < perTeam; k++) {
        const name =
          perTeam > 1 ? fmt(strings.value.game.teamMember, {name: baseName, n: k + 1}) : baseName;
        spawns.push({name, color: cfg.color, model: cfg.model, team, human});
      }
    }
    this.m_teamCount = teamOfColor.size; // sides actually on the field (colours, not roster slots)

    // Position the tanks spread across the whole WORLD (not just the view) so a large
    // map is actually used, with a little jitter and clamped to the world.
    const n = spawns.length;
    const slots = this.spawnSlots(n); // identity, or a shuffle under Randomize Position
    for (let i = 0; i < n; i++) {
      const s = spawns[i];
      const pTank = new CTank(s.name, s.team);
      pTank.setColor(s.color); // hull colour (and team identity)
      if (s.model) pTank.setTankType(s.model);
      pTank.init(this.tankSpawnX(slots[i], n), this.m_land);
      pTank.setHuman(s.human);
      this.randomizeStartAim(pTank); // its own opening aim, not a shared 45°
      pTank.setWeaponIndex(this.m_currentWeaponIndex); // its own starting weapon
      // Starting purse scales with squad size: each tank begins with `perTeam × CreditStart`
      // (the original seeds every member this way, and team-pooling shares one balance, so a
      // squad of N spends against N × CreditStart — not a flat CreditStart). ULTRA CPU tanks get a
      // bigger floor so they can actually afford a real nuke ($4000-8000) instead of only cheap rounds.
      const ultraBot = !s.human && this.m_difficulty === AI_LEVEL_ULTRA;
      const seed = ultraBot
        ? Math.max(this.m_startCredits, CGameController.ULTRA_START_CREDITS)
        : this.m_startCredits;
      pTank.setCredits(seed * perTeam);

      this.m_tanks.push(pTank);
    }

    // Credits are per-tank; the depot spends against ONE bound tank's balance. Solo binds to
    // the human tank BY REFERENCE (not index 0 — Randomize Turns may shuffle the array). In a
    // net match EVERY tank is human, so bind to the LOCAL player's tank — this client's depot
    // buys/consumes only its own inventory (peers never touch it; each client owns one economy,
    // and credits sync via the per-turn snapshot). Reset the inventory for the fresh match.
    const ownTank = this.m_netMode
      ? (this.m_tanks[this.m_netLocalIndex] ?? this.m_tanks[0])
      : (this.m_tanks.find(t => t.isHuman()) ?? this.m_tanks[0]);
    this.m_economy.bindCredits(ownTank);
    this.m_economy.reset(this.m_startCredits * perTeam); // squad-scaled purse (see per-tank seed above)
    this.m_botEconomy.clear(); // fresh bot inventories for the new match (re-created on first bot turn)
    this.m_ultraShot.clear(); // fresh Ultra ranging memory
    this.m_ultraPersonality.clear(); // re-draw Ultra personalities for the new match
    this.m_ultraLastLife.clear();
    this.m_friendlyDamage.clear(); // grudges don't carry into a new match — everyone starts trusted
    this.m_ultraEnemyFire.clear(); // nor does what the other side threw in the last one
    for (const t of this.m_tanks) t.setCanBuy(true); // Buy Time: depot open at battle start
    // Randomize Turns (Gameplay): shuffle the turn queue once per battle. Never in a net
    // match — the server owns the order, and shuffle uses Math.random() (would desync).
    if (GameConfig.randomizeTurns && !this.m_netMode) this.shuffleTurnOrder();

    // Preload hull sprites for the tanks in play (fire-and-forget; the renderer
    // falls back to vector hulls until they are ready).
    for (const tank of this.m_tanks) {
      for (const s of tank.getRequiredSprites()) {
        this.m_assets.loadSprite(s.name, s.file);
      }
    }

    // Preload projectile sprites (each weapon's `bitmap` under assets/weapons/) —
    // this includes the beam weapons' colour textures (magma.bmp, grate.bmp, …), which
    // the beam draw stretches along the ray. They use a magenta (255,0,255) background,
    // same as the hull sprites.
    const bitmaps = new Set(WEAPON_DATABASE.map(w => w.bitmap).filter(Boolean));
    for (const bmp of bitmaps) {
      this.m_assets.loadSprite(`weapons/${bmp}`, `/assets/weapons/${bmp}`);
    }
    // The green turn-indicator triangle (bounces over the active tank).
    this.m_assets.loadSprite('gui/turn-arrow', '/assets/gui/arrow.bmp');
    // Shield icon shown on a tank's badge when it has shields (magenta-keyed).
    this.m_assets.loadSprite('gui/shield', '/assets/gui/shield.bmp');
    // The aim crosshair (magenta-keyed white "+" with a black outline) that marks
    // the (angle, power) aim point — the "target turret" reticle.
    this.m_assets.loadSprite('gui/target', '/assets/gui/target turret.bmp');
    // Off-screen shot notches (gated on the "Tracking" option): top arrows (up
    // while rising, down while falling) + left/right edge brackets pointing at a
    // projectile that has left the view.
    this.m_assets.loadSprite('gui/notch-center', '/assets/gui/notch center.bmp');
    this.m_assets.loadSprite('gui/notch-decent', '/assets/gui/notch center decent.bmp');
    this.m_assets.loadSprite('gui/notch-left', '/assets/gui/notch left.bmp');
    this.m_assets.loadSprite('gui/notch-right', '/assets/gui/notch right.bmp');
    // Booster-jet exhaust flame drawn below a flying tank (black bg → additive glow).
    this.m_assets.loadImage('gui/jet', '/assets/gui/jet.bmp');
    // Supply crate: the parachute assembly (falling, wobbling) + the bare crate (landed).
    this.m_assets.loadSprite('gui/crate-chute', '/assets/gui/crate parachute.bmp');
    this.m_assets.loadSprite('gui/crate', '/assets/gui/crate.bmp');
    // Sentry turret hull/turret/wreck. Preloaded HERE rather than left to deploySentry: a sentry is
    // born mid-battle, and CTank.draw falls back to the crude vector hull until its sprites decode —
    // so loading them at deploy time flashed a placeholder turret for the first frames. The loop
    // above only covers tanks already on the field, and no Sentry exists yet.
    for (const s of SENTRY_SPRITES) this.m_assets.loadSprite(s.name, s.file);

    // Particle FX sprites (the real game art): grey smoke puff (magenta-keyed)
    // and the additive starburst flare used for trail plumes / fireballs.
    this.m_assets.loadSprite('fx:smoke', '/assets/gui/smoke.bmp');
    // The rocket-exhaust colour TABLE — a 2-D lookup the author baked: X = age (bright/hot young →
    // cool old), Y = height (top light → bottom dark). The particle system samples it per exhaust
    // puff at (age, height) so the trail glows at the nozzle and greys by height in one step.
    this.m_assets.loadSprite('fx:plume', '/assets/gui/rocket plume.bmp');
    this.m_assets.loadImage('fx:flare', '/assets/flares/04.bmp');
    // The generic fallback fireball, keyed on its light blue-purple bg.
    this.m_assets.loadSprite('fx:explosion', '/assets/effects/explosion1.bmp', [127, 127, 255]);
    // Each weapon explodes with its OWN flare sprite (expBitmap): load the distinct
    // set. They're on a black background → additive blit, no colorkey needed.
    for (const b of new Set(WEAPON_DATABASE.map(w => w.expBitmap).filter(Boolean))) {
      this.m_assets.loadImage(`fx:${b}`, `/assets/${b}`);
    }
    // The in-flight rocket flare (flareType/flareBmp), black-bg → additive.
    this.m_assets.loadImage('fx:flares/01.bmp', '/assets/flares/01.bmp');
    this.m_particles.setAssets(this.m_assets);

    // Pick a landscape (background + depth-layered terrain textures + weather). Keep the
    // promise so the UI can hold a loading screen until the sky/terrain are textured
    // (see assetsReady) instead of flashing the gradient-sky / untextured fallback.
    this.m_loadPromise = this.loadLandscape();

    // Randomize wind
    this.updateWind();

    // Set initial state
    // Player 0 (the human) takes the first turn.
    this.m_currentPlayerIndex = 0;
    this.beginTurn();
    // Snap the camera onto the first player so a large map opens framed on them
    // (rather than panning in from the world's left edge).
    this.m_manualScroll = false;
    this.centerCameraOn(this.getCurrentTank().getPosition().x);

    // Warm the combat SFX set and start a random battle track.
    this.m_audio?.preloadCombat();
    this.m_audio?.battleMusic();
  }

  /**
   * Pick a random landscape from land.json and load its background + depth-sorted
   * terrain textures. Fire-and-forget: the terrain shows a gradient until ready.
   *
   * Called at every LEVEL build — match start AND each new battle of a war — because that is
   * what the original does: the war's next battle runs the whole level builder again
   * (`FUN_004259c0(this, -1, …)`), whose `-1` means "roll a random ENABLED background", and the
   * chosen background is also the key into `land.txt` for the strata textures + weather. So a
   * new battle is a new CLIMATE, not just a new heightmap.
   */
  private async loadLandscape(): Promise<void> {
    const cfg = LAND_DATA[this.pickLandscapeIndex()];

    // Load every asset BEFORE touching the live scene (the swap block below is synchronous), so a
    // between-battles change never shows a half-applied climate: the outgoing map keeps its sky,
    // strata and weather until the incoming one is fully decoded.
    //
    // The sky is keyed by its FILE, not a fixed 'bg' slot — CAssetManager dedupes by NAME, so a
    // reused slot would resolve instantly against the FIRST battle's image and pin that sky for
    // the whole war. Per-file keys also make revisiting a landscape free.
    const bgKey = 'bg:' + cfg.bg;
    await this.m_assets.loadImage(bgKey, '/assets/' + cfg.bg);

    await Promise.all([
      ...cfg.layers.map(l => this.m_assets.loadImage('tile:' + l.tile, '/assets/' + l.tile)),
      // Bare-earth texture for de-grassed craters + the raised radiation deposit: a
      // single dirt bitmap (`ldirt1.bmp`), loaded explicitly and used everywhere
      // craters expose / fallout deposits earth — a consistent brown dirt regardless
      // of the landscape (which may be mossy rock, marble, …).
      this.m_assets.loadImage('tile:land/ldirt1.bmp', '/assets/land/ldirt1.bmp'),
    ]);

    this.m_bgKey = bgKey;
    this.m_ambient = hexToRgb(cfg.ambient); // per-map mood tint for Ambient Lighting (from land.json)

    // Precipitation / blowing sand declared by this map (snow, rain, hail, dust). Size the weather
    // field to THIS match's logical view first — it was created at the boot canvas size, which differs
    // from m_viewW/H on a net match (host resolution) or after a pre-Play window resize, otherwise
    // leaving a strip of sky with no precipitation or a visible toroidal-wrap seam inside the view.
    this.m_weather.setBounds(this.m_viewW, this.m_viewH);
    this.m_weather.configure(cfg.weather); // replaces the previous battle's bands outright

    // A themed name for the depot footer, derived from the map's dominant weather (localised).
    const wx = new Set((cfg.weather ?? []).map(w => w.type));
    const mapNames = strings.value.game.mapNames;
    this.m_mapName = wx.has('snow')
      ? mapNames.snow
      : wx.has('dust')
        ? mapNames.dust
        : wx.has('rain')
          ? mapNames.rain
          : wx.has('hail')
            ? mapNames.hail
            : mapNames.default;

    const layers = cfg.layers
      .map(l => {
        const sprite = this.m_assets.getSprite('tile:' + l.tile);
        return sprite ? {image: sprite.bitmap, depth: l.depth} : null;
      })
      .filter((x): x is {image: CanvasImageSource; depth: number} => x !== null);

    const bareTile =
      cfg.layers.find(l => /dirt|sand|mud|clay/i.test(l.tile)) ??
      cfg.layers.find(l => !/grass/i.test(l.tile)) ??
      cfg.layers[cfg.layers.length - 1];
    const bareImage =
      this.m_assets.getSprite('tile:land/ldirt1.bmp')?.bitmap ??
      (bareTile ? this.m_assets.getSprite('tile:' + bareTile.tile)?.bitmap : undefined);

    this.m_land.setLayers(layers, bareImage);
  }

  /** Pick which landscape to load. Honours a `?land=N` override (for reviewing a
   * specific map / its weather), otherwise random. */
  private pickLandscapeIndex(): number {
    if (typeof location !== 'undefined') {
      const p = new URLSearchParams(location.search).get('land');
      if (p !== null) {
        const i = parseInt(p, 10);
        if (Number.isInteger(i) && i >= 0 && i < LAND_DATA.length) return i;
      }
    }
    // Choose only among enabled landscapes (Game Content); if all are disabled,
    // degrade to the full set rather than blocking. In a network match ignore the local
    // Game Content filter (per-client) and pick from the FULL pool via the seeded RNG, so
    // every client shows the same backdrop/weather/textures.
    if (this.m_netMode) {
      const all = LAND_DATA.map((_, i) => i);
      return all[this.m_rng.int(all.length)];
    }
    const enabled = LAND_DATA.map((_, i) => i).filter(landEnabled);
    const pool = enabled.length ? enabled : LAND_DATA.map((_, i) => i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ========================================================================
  // GAME LOOP & UPDATE
  // ========================================================================

  /**
   * Drive the sim from real (wall-clock) time. Accumulates elapsed time (scaled by the
   * game-speed setting) and runs the sim in FIXED_DT slices — so the same shot resolves
   * in the same number of steps on every client, at any frame rate (lockstep). Tests
   * bypass this and call {@link update} with an explicit dt.
   */
  advance(realDt: number): void {
    if (!this.m_started) return; // no battle yet (main menu at boot) — nothing to simulate
    // Clamp the accumulator (never DROP steps mid-loop): a dropped step makes a hitching
    // client run fewer steps for a shot than a smooth one → the sims diverge (a keyframe
    // then has to resync, leaving a visible dirt patch). A frame hitch (e.g. a big blast)
    // is fully caught up within MAX_ACCUM; only a multi-second stall (backgrounded tab)
    // clamps — and that client resyncs from the next keyframe anyway.
    this.m_simAccum = Math.min(
      this.m_simAccum + realDt * this.m_speedScale,
      CGameController.MAX_SIM_ACCUM,
    );
    const step = CGameController.FIXED_DT;
    while (this.m_simAccum >= step) {
      this.update(step);
      this.m_simAccum -= step;
    }
  }

  update(dt: number): void {
    switch (this.m_gameState) {
      case EGameState.Battle:
        this.updateBattle(dt);
        this.relayLiveAim(); // net: stream the local player's turret movement to spectators
        break;

      case EGameState.Flying:
        this.updateFlying(dt);
        break;

      case EGameState.ShotFlying:
        this.updateShotInFlight(dt);
        break;

      case EGameState.Explosion:
        // Tanks keep falling/settling into the fresh craters while the blast animates.
        this.updateTanks(dt);
        // Hand off once the EXPLOSION and every tank have come to rest — the blast's fireball / fire /
        // sparks (hasActiveBlast, which ignores the lingering cosmetic smoke — the turn waits for the
        // explosion, NOT its multi-second smoke fade), screen-shake, a beam-slice collapse or debris
        // still settling (m_land.isSettling), and any tank still falling/sliding from the blast. The
        // smoke keeps drifting into the next player's aim phase (it's purely visual).
        if (
          !this.m_particles.hasActiveBlast() &&
          !this.m_screenShake.isActive() &&
          !this.m_land.isSettling() &&
          !this.m_tanks.some(t => t.isAlive() && (t.isFalling() || t.isMoving()))
        ) {
          this.endTurn();
        }
        break;

      case EGameState.BattleEnd:
        this.m_battleEndTime += dt; // drives the winner flag raise + wave animation
        this.updateFireworks(dt); // victory sky fireworks (no-op unless the human won)
        break;
    }

    // Always update terrain, wind and visual effects
    this.m_time += dt;
    this.updateEffectiveWind(dt); // fold Realistic-mode gusts onto the base wind → m_effWind
    this.updateCamera(dt); // ease the large-map camera toward the shot / active tank
    if (this.m_damageNumbers.length) {
      for (const d of this.m_damageNumbers) d.age += dt;
      this.m_damageNumbers = this.m_damageNumbers.filter(d => d.age < DMG_NUM_LIFE);
    }
    if (this.m_blastCircles.length) {
      for (const c of this.m_blastCircles) c.age += dt;
      this.m_blastCircles = this.m_blastCircles.filter(c => c.age < BLAST_CIRCLE_LIFE);
    }
    this.updateTaunts(dt); // age speech bubbles + run the idle-taunt countdown
    this.updateCrates(dt); // descend / land / collect supply crates + age pickup text
    this.m_land.update(dt, this.m_effWind);
    // Change Wind (Gameplay): only "Anytime" (3) drifts continuously; Per-game / After-round /
    // After-shot hold the vector constant between their discrete rerolls (see endTurn).
    if (GameConfig.changeWind === 3) this.updateWindDrift(dt);
    this.m_particles.update(dt, this.m_effWind);
    this.m_weather.update(dt, this.m_effWind);
    this.updateGhostShots(dt); // spectator-only visual arcs (network match)
    if (this.m_screenFlash > 0) this.m_screenFlash = Math.max(0, this.m_screenFlash - dt / 0.6);
    this.updateMoveSound();

    // Fire any due deferred actions (bot turns, turn hand-off). These run off the
    // sim clock — not wall-clock timers — so they freeze with the rest of the game
    // while paused (update() is skipped) instead of firing behind the pause.
    this.runTimers();
  }

  /**
   * Invalidate the frame — the next draw must be rendered. Called on any input or
   * one-off state change (aim, weapon, mouse move, entity placement, resize). Also
   * the hook a future networking layer calls when it applies a remote update, so
   * the scene redraws for the remote player's actions even while the local player
   * is idle.
   */
  markDirty(): void {
    this.m_renderGate.markDirty(performance.now());
  }

  /**
   * Tear the current battle down to the boot state. `isStarted()` → false, so the per-frame sim
   * (`advance`), scene redraw (`shouldRedraw`/`draw`) and HUD overlay all short-circuit exactly as
   * they do behind the opaque main menu at boot — nothing advances, animates or draws. Also clears
   * the scene canvas so the frozen last frame doesn't linger under the menu. Called when quitting a
   * battle to the main menu; idempotent (a no-op when no battle is running).
   */
  stopGame(): void {
    if (!this.m_started) return;
    this.m_started = false;
    this.stopMovementAudio(); // kill any tank-drive / jet loop that was running
    const c = this.m_ctx.canvas;
    this.m_ctx.clearRect(0, 0, c.width, c.height); // blank the scene (presented once by the loop)
    this.markDirty();
  }

  /**
   * Whether any GAMEPLAY motion is on screen this frame (as opposed to the purely
   * cosmetic turn-arrow bob / star twinkle, which the gate handles via its grace
   * window). Deliberately conservative: if anything here can move, we keep drawing.
   */
  private isAnimating(): boolean {
    switch (this.m_gameState) {
      case EGameState.Flying:
      case EGameState.ShotFlying:
      case EGameState.Explosion:
        return true; // shot/flight/blast in progress
      case EGameState.BattleEnd:
        return true; // the winner flag keeps raising / waving on the standings
    }
    if (this.m_screenShake.isActive()) return true;
    if (this.m_camX !== this.m_camTargetX) return true; // camera still panning
    if (this.m_screenFlash > 0) return true;
    if (this.m_particles.hasActiveExplosions()) return true;
    if (this.m_weather.isActive()) return true; // rain/snow/dust never rest
    if (this.m_land.isAnimating()) return true; // debris / fallout / slump / terrain rebuild
    if (!this.m_assets.isReady()) return true; // sprites still popping in
    if (this.m_damageNumbers.length) return true; // floating damage text rising/fading
    if (this.m_blastCircles.length) return true; // blast-circle rings fading
    if (this.m_crates.length) return true; // parachute crates falling / wobbling
    if (this.m_floatTexts.length) return true; // crate-pickup messages rising/fading
    for (const s of this.m_shots) if (!s.isDead()) return true;
    for (const m of this.m_mines) if (m.armed > 0) return true; // arming → colour flips
    for (const t of this.m_tanks)
      if (t.isMoving() || t.isFalling() || t.isThrustingUp()) return true;
    return false;
  }

  /**
   * Decide whether to redraw + re-upload the scene this frame. The game loop always
   * ticks update() (so the sim keeps advancing); only the expensive redraw + GPU
   * upload are gated here. Returns true whenever something changed or is moving.
   */
  shouldRedraw(): boolean {
    if (!this.m_started) return false; // no battle yet (main menu at boot) — skip the scene redraw
    return this.m_renderGate.shouldRedraw(this.m_paused, this.isAnimating(), performance.now());
  }

  /**
   * Schedule `fn` to run after `sec` of *simulation* time. Because it's driven by
   * update() (which is skipped while paused), the callback is naturally deferred
   * across a pause rather than firing on the wall clock. Replaces setTimeout for
   * all game-flow delays so pause actually freezes the flow.
   */
  private schedule(sec: number, fn: () => void): void {
    this.m_timers.push({at: this.m_time + sec, fn});
  }

  /** Run (and drop) every scheduled action whose sim-time has arrived. */
  private runTimers(): void {
    if (this.m_timers.length === 0) return;
    const due = this.m_timers.filter(t => this.m_time >= t.at);
    if (due.length === 0) return;
    this.m_timers = this.m_timers.filter(t => this.m_time < t.at);
    for (const t of due) t.fn();
  }

  /**
   * Pause/resume the whole game. The sim clock (update) stops in the loop, the gameplay-SFX audio
   * context is suspended (in-flight explosions and drive/jet loops FREEZE and resume in sync on
   * unpause — while music and UI sounds keep playing, so the depot / pause menu aren't silent), and
   * all player input is rejected (the fire/aim/angle/power/weapon handlers below early-out) so
   * nothing at all moves while paused.
   */
  setPaused(paused: boolean): void {
    if (paused === this.m_paused) return;
    this.m_paused = paused;
    if (paused) this.m_movePlacing = false; // pausing disarms a pending Move placement
    this.markDirty(); // draw the pause frame once; redraw on resume
    if (paused) void this.m_audio?.suspend();
    else void this.m_audio?.resume();
  }

  /**
   * Drive the looping `tank moving.wav` from tank motion state: start the named
   * loop while a unit moves, stop it when none do, repan to the mover. Idempotent
   * starts are handled downstream.
   */
  private updateMoveSound(): void {
    if (!this.m_audio) return;
    const mover = this.m_tanks.find(t => t.isAlive() && t.isMoving());
    if (mover) {
      const x = mover.getPosition().x;
      if (!this.m_tanksMoving) {
        this.m_audio.startTankMove(x);
        this.m_tanksMoving = true;
      } else this.m_audio.updateTankMove(x);
    } else if (this.m_tanksMoving) {
      this.m_audio.stopTankMove();
      this.m_tanksMoving = false;
    }

    // jet.wav loops only while the up-thrust is firing, layered
    // under tank moving.wav. Stops the instant thrust releases or fuel runs out.
    const jet = this.m_tanks.find(t => t.isAlive() && t.isThrustingUp());
    if (jet) {
      const x = jet.getPosition().x;
      if (!this.m_jetSounding) {
        this.m_audio.startJet(x);
        this.m_jetSounding = true;
      } else this.m_audio.updateJet(x);
    } else if (this.m_jetSounding) {
      this.m_audio.stopJet();
      this.m_jetSounding = false;
    }
  }

  /** Silence the per-frame movement loops (tank-drive / jet) and reset their state. Call when LEAVING
   *  a battle: updateMoveSound is the only thing that stops these loops, but it runs from update() —
   *  which is skipped while the sim is frozen. Quitting to the menu mid-drive freezes the sim yet
   *  RESUMES the AudioContext (goToMenu), so a drive/jet drone would otherwise play on under the menu
   *  until the next battle's first frame. Safe to call anytime (no-op when nothing is looping). */
  stopMovementAudio(): void {
    if (this.m_tanksMoving) {
      this.m_audio?.stopTankMove();
      this.m_tanksMoving = false;
    }
    if (this.m_jetSounding) {
      this.m_audio?.stopJet();
      this.m_jetSounding = false;
    }
  }

  /**
   * Jet flight (extType 17): the active tank thrusts against gravity until its
   * fuel runs out and it settles. Flight repositions the tank but does NOT end
   * the turn; the player still fires afterwards. Other tanks keep falling/settling
   * passively.
   */
  private updateFlying(dt: number): void {
    const tank = this.getCurrentTank();
    this.updateTanks(dt);
    this.updateMines(dt);
    // Back to the aim phase once the jet is spent and the tank has settled.
    if (!tank.hasJetFuel() && !tank.isMoving() && !tank.isFalling()) {
      tank.setJetInput(false, false, false);
      this.m_gameState = EGameState.Battle;
      // Flight's over and the human is aiming again — RESUME the shot clock (paused at ignite, not
      // reset) so jetting can't grant unlimited time to line up the follow-up shot.
      this.armShotClock(false);
    }
  }

  /** Set the flying tank's held thrust (arrow/WASD). No-op outside the Flying state. */
  setJetInput(up: boolean, left: boolean, right: boolean): void {
    if (this.m_gameState !== EGameState.Flying) return;
    this.getCurrentTank().setJetInput(up, left, right);
    // NET: relay the thrust so spectators reproduce the SAME flight. Flight is followed by an aim+fire
    // in the SAME turn (before any turn-end keyframe), so a spectator that only saw the ignite lands
    // the tank elsewhere and the relayed shot simulates from the wrong spot — every later shot then
    // diverges. Relay only on the local turn, and only on a real change (key auto-repeat resends).
    if (this.m_netMode && this.isLocalNetTurn()) {
      const j = this.m_lastJetRelay;
      if (!j || j.up !== up || j.left !== left || j.right !== right) {
        this.m_lastJetRelay = {up, left, right};
        this.m_onNetCommand?.({t: 'jet', up, left, right});
      }
    }
  }

  /** Cut the jet early (drop remaining fuel); flight ends once the tank lands. */
  cutJet(): void {
    if (this.m_gameState !== EGameState.Flying) return;
    this.getCurrentTank().cutJet();
    // NET: relay the cut so spectators drop the remaining fuel at the same moment (same landing).
    if (this.m_netMode && this.isLocalNetTurn()) this.m_onNetCommand?.({t: 'cutJet'});
  }

  // ========================================================================
  // DRAG-TO-AIM (the primary control)
  // ========================================================================

  /** Longest drag (px) = full power (also the arrow's max length). */
  private static AIM_MAX_DRAG = 400;

  /**
   * The point the aim angle is measured from — the turret PIVOT (where the barrel
   * hinges), not the hull top. The barrel rotates around this pivot, so measuring the
   * cursor angle from anywhere else (the old hull-top origin sat ~9px above it) leaves
   * the barrel pointing slightly off the cursor — worst at short drags / steep angles.
   * Using the pivot makes barrel, muzzle, aim arrow and cursor collinear.
   */
  private aimOrigin(): Vec2 {
    return this.getCurrentTank().getTurretPivot();
  }

  /** Begin aiming from the current tank (world coords). No-op unless it's a human's turn. */
  beginAim(wx: number, wy: number): boolean {
    if (!this.canAct()) return false; // paused / not your turn / mid-move / jet flight → no aiming
    if (this.m_movePlacing) return false; // a click is a move-destination, not an aim drag
    this.m_aim.active = true;
    this.dragAim(wx, wy);
    return true;
  }

  /** Update aim while dragging: angle = tank→cursor direction, power = drag length. */
  dragAim(wx: number, wy: number): void {
    if (this.m_paused || !this.m_aim.active) return;
    this.m_aim.tx = wx;
    this.m_aim.ty = wy;

    const o = this.aimOrigin();
    const dx = wx - o.x,
      dy = wy - o.y;
    // Screen-Y is down; up-aim → negative dy → larger angle. 0 = right, 90 = up,
    // 180 = left, 270 = down. atan2 returns (-180,180]; fold into the wrapping
    // 0..359 range the HUD uses (so down-right reads 315, not -45).
    const angleDeg = ((((Math.atan2(-dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    const frac = Math.min(1, Math.hypot(dx, dy) / CGameController.AIM_MAX_DRAG);
    const power = 10 + frac * 990; // POWER_MIN(10)..POWER_MAX(1000)

    this.setAngle(Math.round(angleDeg));
    this.setPower(Math.round(power));
  }

  /** Release the drag. If it was a real aim, fire. */
  endAim(fire: boolean): void {
    this.markDirty(); // the aim arrow disappears this frame
    const wasActive = this.m_aim.active;
    this.m_aim.active = false;
    if (fire && wasActive && this.m_gameState === EGameState.Battle && this.isPlayerTurn()) {
      this.requestFire(); // human input → wind up the FIRE bar before launching
    }
  }

  // ========================================================================
  // CAMERA (large-map horizontal scroll)
  // ========================================================================

  /** Land-Size scale (1..5); world width = viewWidth × scale. */
  private landScale(): number {
    if (this.m_netMode) return this.m_netLandScale; // host-chosen, shared across clients
    return clamp(Math.round(GameConfig.landSize), 1, 5);
  }

  /**
   * Resolution-based blast scale (the original's explosion-scale factor): the crater/FX radius and the
   * blast-damage falloff radius are both `weapon.radius × explosionScale × this`. A DERIVED render
   * value (not a user setting), exposed on the `ShotWorld` context — computed on demand from the LIVE
   * canvas so it always tracks the current window size (no resize-timing state to keep in sync).
   */
  get blastScale(): number {
    return this.computeBlastScale(this.m_viewW, this.m_viewH);
  }

  /**
   * The original's factor `√(screenW·screenH) × C`, C = 1/600 for a ≤800px-wide view else 1/900 —
   * ≈1.0 at typical resolutions, so a weapon's radius reads at its authored px size.
   */
  private computeBlastScale(viewW: number, viewH: number): number {
    // Guard against an unsized canvas (0/NaN dims during early construction) — never return 0/NaN,
    // which would zero the blast radius and carve NO crater. Fall back to the classic 800×600.
    const w = viewW > 0 ? viewW : 800;
    const h = viewH > 0 ? viewH : 600;
    // The ORIGINAL's factor: √(screen area) × C, with C = 1/600 for a ≤800px-wide view else 1/900.
    // (A flat 1/600 at all sizes over-scaled blasts ~1.5–2.4× on modern windows.) Gives ≈1.0 at typical
    // resolutions, so a weapon's radius reads at its authored px size.
    const c = w <= 800 ? 1 / 600 : 1 / 900;
    return Math.sqrt(w * h) * c;
  }

  /** Widest the camera can scroll; 0 when the world fits the view (no scroll). */
  private maxCamX(): number {
    return Math.max(0, this.m_worldWidth - this.m_viewW);
  }

  private clampCamX(x: number): number {
    return clamp(x, 0, this.maxCamX());
  }

  /** World X of the view's left edge — for input→world mapping and world draw. */
  getCameraX(): number {
    return this.m_camX;
  }

  /**
   * What the camera centres on this frame:
   *  1. the latched active shot while it's in the air (a single, stable target — not
   *     "whichever shot is alive", which jumps around a multi-missile salvo);
   *  2. once that shot has landed, the blast, held until the explosion finishes (so a
   *     nuke plays out on screen before the turn hands off);
   *  3. otherwise the active tank.
   * The active shot latches to the first shot of the salvo and never re-picks, so
   * later missiles landing elsewhere don't yank the camera.
   */
  private cameraFollowX(): number {
    if (this.m_activeShot) {
      if (!this.m_activeShot.isDead()) return this.m_activeShot.getPosition().x;
    } else {
      const first = this.m_shots.find(s => !s.isDead());
      if (first) {
        this.m_activeShot = first;
        return first.getPosition().x;
      }
    }
    // Hold on the impact for the WHOLE shot-resolution window — a live shot is handled above, so this
    // covers the between-salvos gap (ShotFlying) and the blast+settle (Explosion), right up to the turn
    // hand-off (endTurn only leaves Explosion once the blast, terrain settle and any flung tank all come
    // to rest). Keying on the STATE — not hasActiveBlast() — holds through the post-blast settle tail
    // (debris slumping, a knocked-up tank still falling) instead of easing toward the shooter early; and
    // it does NOT hold during a Move drive (that's Battle state), so the camera follows the driving tank.
    // Once the turn hands off, state is Battle and we follow the new current tank — no crater smoke lag.
    // ...and, in Cinematic mode, keep lingering on the impact for a beat AFTER the hand-off (m_camDwell,
    // counted down in updateCamera) before the pan to the next player begins.
    if (
      this.m_gameState === EGameState.ShotFlying ||
      this.m_gameState === EGameState.Explosion ||
      this.m_camDwell > 0
    ) {
      return this.m_lastImpactX;
    }
    // Battle over: frame the VICTOR (their flag-raise + fireworks play out here), not whoever happened
    // to act last — on a multi-viewport map the winning tank can be across the map. Draw → fall through.
    if (this.m_gameState === EGameState.BattleEnd) {
      const winner = this.getWinnerTank();
      if (winner) return winner.getPosition().x;
    }
    return this.getCurrentTank().getPosition().x;
  }

  /**
   * Ease the camera toward its follow target — constant speed, snapping when within
   * one step (matching the original, which is NOT a proportional lerp). Skipped
   * while the player manually scrolls via the minimap or Auto Scroll is off; the
   * result is always clamped to the world.
   */
  private updateCamera(dt: number): void {
    if (this.m_camDwell > 0) this.m_camDwell -= dt; // Cinematic dwell on the impact, then release the pan
    if (this.maxCamX() === 0) {
      this.m_camX = this.m_camTargetX = 0;
      return;
    }
    if (GameConfig.autoScroll && !this.m_manualScroll) {
      this.m_camTargetX = this.clampCamX(this.cameraFollowX() - this.m_viewW * CAMERA_CENTER);
      const step = CAMERA_SCROLL_SPEED * dt;
      const d = this.m_camTargetX - this.m_camX;
      this.m_camX = Math.abs(d) <= step ? this.m_camTargetX : this.m_camX + Math.sign(d) * step;
    }
    this.m_camX = this.clampCamX(this.m_camX);
  }

  /** Snap the camera to centre `worldX` immediately (battle start / recenter). */
  private centerCameraOn(worldX: number): void {
    this.m_camTargetX = this.clampCamX(worldX - this.m_viewW * CAMERA_CENTER);
    this.m_camX = this.m_camTargetX;
  }

  /** Render frame to canvas - called every frame. */
  draw(): void {
    if (!this.m_started) {
      // No battle (boot menu, or a match just torn down). The GPU smoke layer lives OUTSIDE the
      // scene canvas, so clearing that canvas does not touch it — publish an empty frame or the
      // last battle's smoke stays painted over the menu forever.
      this.m_smokeSink?.smokeBegin();
      this.m_smokeSink?.smokeEnd();
      return;
    }
    const ctx = this.m_ctx;

    // The scene canvas IS the logical world (m_viewW × m_viewH); the compositor stretches it
    // to the display (GPU, linear-filtered — no CPU-scale moiré on the pixel terrain).

    // Apply screen shake offset
    const shakeOffset = this.m_screenShake.getOffset();
    ctx.save();
    ctx.translate(shakeOffset.x, shakeOffset.y);

    // Backdrop: real background image once loaded, else a night-sky gradient.
    const bg = this.m_bgKey ? this.m_assets.getSprite(this.m_bgKey) : null;
    if (bg) {
      ctx.drawImage(bg.bitmap, 0, 0, this.m_viewW, this.m_viewH);
    } else {
      const skyGradient = ctx.createLinearGradient(0, 0, 0, this.m_viewH - 120);
      skyGradient.addColorStop(0, '#1a1a2e'); // Dark night
      skyGradient.addColorStop(0.6, '#16213e'); // Mid blue
      skyGradient.addColorStop(1, '#0f3460'); // Horizon

      ctx.fillStyle = skyGradient;
      ctx.fillRect(0, 0, this.m_viewW, this.m_viewH);

      // Draw stars (subtle background)
      this.drawStars(ctx);
    }

    // Weather (rain / snow / hail / dust) sits between the backdrop and the
    // terrain, so it only shows against the sky and is occluded by the ground.
    // It fills the VIEW (screen space), so it's drawn before the camera shift.
    this.m_weather.draw(ctx);

    // Everything below is WORLD content: shift left by the camera so a large map
    // scrolls under the fixed view (screen = world − cam). The backdrop above and
    // the notches/minimap below draw OUTSIDE this transform, in screen space.
    ctx.save();
    ctx.translate(-this.m_camX, 0);

    // Draw terrain (mirror only the on-screen span → the terrain tile stays view-sized, not world-sized)
    this.m_land.setViewport(this.m_camX, this.m_viewW);
    this.m_land.draw(ctx);
    // The radioactive heat haze belongs to the GROUND, so it paints here — right after the terrain
    // and under the tanks/aim overlay, the slot it occupied when CLand still owned the pool. The
    // particles themselves now live in the particle system (see IHeatSink).
    this.m_particles.drawHeat(ctx);
    // Cosmetic dirt spray (beam dust / buried digger). Depositing crater ejecta stays with the
    // terrain and is drawn inside m_land.draw above — see IFxSink on why they are separate.
    this.m_particles.drawDebris(ctx);

    // Draw tanks
    for (const tank of this.m_tanks) {
      if (tank.isAlive()) {
        // Hull only — the tank's BADGE (name / life bars / hover stats) is painted
        // on the foreground overlay (drawOverlay) so it renders over the HUD rather
        // than being clipped at the world canvas's bottom edge.
        const hover = tank.isPointInside(this.m_mouse.x, this.m_mouse.y);
        tank.draw(ctx, this.m_assets, hover, false);

        // Highlight current player's tank with indicator (Graphics → Show Turn)
        if (
          GameConfig.showTurn &&
          this.getCurrentTank() === tank &&
          this.m_gameState !== EGameState.ShotFlying &&
          this.m_gameState !== EGameState.Explosion &&
          this.m_gameState !== EGameState.BattleEnd
        ) {
          this.drawTurnIndicator(ctx, tank);
        }
      } else if (tank.m_bExploded && !tank.isAlive()) {
        // Draw wreckage for exploded but not yet cleaned up tanks
        tank.draw(ctx, this.m_assets);
      }
    }

    // Between battles: plant a flag by the winning tank and show its taunt bubble.
    // On a war-end victory, fireworks burst across the sky behind the standings.
    if (this.m_gameState === EGameState.BattleEnd) {
      this.drawFireworks(ctx);
      this.drawWinnerFlag(ctx);
    }

    this.drawPlacedEntities(ctx);
    this.drawCrates(ctx); // supply crates (parachute wobble / landed on the slope)
    this.drawBlastCircles(ctx); // Show Blast Circles: explosion-radius rings
    this.drawMoveArea(ctx);
    this.drawAimTarget(ctx);
    this.drawAim(ctx);
    this.drawFloatTexts(ctx); // crate-pickup messages

    // Trail / explosion particles. These use additive ('lighter') blending, so they
    // stay in the world scene (over the opaque backdrop) — moving them to the
    // transparent fx overlay would turn their black-bg sprites into black boxes.
    // Hand the view rect (world-X of the left edge + on-screen size) so the particle system can
    // off-screen-cull and render its smoke to a half-res buffer (perf under heavy strikes).
    this.m_particles.setViewport(this.m_camX, this.m_viewW, this.m_viewH);
    // The smoke layer is GPU-batched when a sink is wired (see ISmokeSink): the puffs are emitted
    // as world-space quads here instead of being blitted, and drawn in ONE call by the compositor.
    // Its transform has to match the world transform this canvas is under — camera and shake.
    this.m_smokeSink?.setSmokeTransform(
      this.m_camX,
      shakeOffset.x,
      shakeOffset.y,
      this.m_viewW,
      this.m_viewH,
    );
    this.m_smokeSink?.smokeBegin();
    this.m_particles.draw(ctx);
    this.m_smokeSink?.smokeEnd();

    // Active projectiles ON TOP of their own trail — so the missile sprite is
    // visible ahead of its exhaust+smoke, not buried under the fire head.
    for (const shot of this.m_shots) {
      if (!shot.isDead()) {
        const wi = shot.getWeaponIndex() >= 0 ? shot.getWeaponIndex() : this.m_currentWeaponIndex;
        const weapon = getWeapon(wi);
        // A tracer has no missile body — draw just the small white round head.
        if (weapon.getExtType() === EXT.TRACER) {
          shot.draw(ctx, '#ffffff', null, weapon.getSize());
          continue;
        }
        const sprite = this.m_assets.getSprite(`weapons/${weapon.getBitmap()}`);
        shot.draw(ctx, weapon.getColor(), sprite?.bitmap ?? null, weapon.getSize());
      }
    }

    // Spectator ghost arcs (network match) — the opponent's shot in flight, drawn
    // exactly like a real projectile but purely visual.
    for (const g of this.m_ghostShots) {
      if (g.isDead()) continue;
      const gw = getWeapon(
        g.getWeaponIndex() >= 0 ? g.getWeaponIndex() : this.m_currentWeaponIndex,
      );
      const sprite = this.m_assets.getSprite(`weapons/${gw.getBitmap()}`);
      g.draw(ctx, gw.getColor(), sprite?.bitmap ?? null, gw.getSize());
    }

    ctx.restore(); // end world-space camera transform → back to screen space

    // Ambient Lighting (Graphics → Ambient Lighting): a subtle soft-light wash of the map's own
    // average colour over the scene, so terrain/tanks take on each backdrop's mood — warm on a sunset
    // map, cool on snow. A port embellishment (the original reads warm purely by backdrop context).
    // Over the world only; the notches/minimap draw after, untinted.
    if (GameConfig.ambientLight && this.m_ambient) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = `rgb(${this.m_ambient.r},${this.m_ambient.g},${this.m_ambient.b})`;
      ctx.fillRect(0, 0, this.m_viewW, this.m_viewH);
      ctx.restore();
    }

    // Edge notches pointing at any projectile that has left the view (Tracking).
    if (GameConfig.tracking) this.drawShotNotches(ctx);

    // Overview minimap (large maps only) — drawn last so it sits on top.
    this.drawMinimap(ctx);

    ctx.restore();
  }

  // Per-map ambient tint (from land.json's `ambient`) for Ambient Lighting — a soft-light wash over
  // the scene so terrain/tanks take each map's mood. Hand-picked per map (a snowy map's raw average
  // is washed-out white; the stored tint leans cool instead). Null → no tint.
  private m_ambient: {r: number; g: number; b: number} | null = null;

  /**
   * Foreground overlay — drawn to a SEPARATE full-viewport canvas that sits ABOVE
   * the HUD (see main.tsx). The original composites everything into one screen
   * buffer with the HUD blitted in, so tank life-bars, damage numbers and the blast
   * fireball all appear over the HUD; our world scene stops at the HUD's top edge,
   * so those dynamic layers move here to render over it. Uses the SAME screen-shake
   * + camera transform as draw() so it stays pixel-aligned with the world.
   */
  drawOverlay(octx: CanvasRenderingContext2D): void {
    if (!this.m_started) return; // no battle yet (main menu at boot) — nothing to overlay
    // Caller pre-scales octx from logical → screen (the fx overlay spans the whole
    // window, but the world maps only to the container region above the HUD, so the
    // scale must use the container size — done in the caller, not here).
    octx.save();
    const shake = this.m_screenShake.getOffset();
    octx.translate(shake.x, shake.y);
    octx.save();
    octx.translate(-this.m_camX, 0);

    // Tank badges (name / life-shield-armour bars / hover stat lines), so a tank
    // low on screen shows its readouts over the HUD instead of being clipped.
    if (this.m_gameState !== EGameState.BattleEnd) {
      for (const tank of this.m_tanks) {
        if (tank.isAlive()) {
          const hover = tank.isPointInside(this.m_mouse.x, this.m_mouse.y);
          tank.paintBadge(octx, hover, this.m_assets);
        }
      }
    }

    // Floating damage numbers (Show Points), world space.
    this.drawDamageNumbers(octx);

    octx.restore();
    octx.restore();
  }

  /**
   * Overview minimap — a top-left strip shown ONLY when the world
   * is wider than the view. It draws the terrain silhouette, a translucent "extents"
   * box for the current camera view, and a dot per tank in its team colour (the
   * active player's dot gets a white outline). Screen-space, with drag-to-pan.
   */
  private drawMinimap(ctx: CanvasRenderingContext2D): void {
    const Vw = this.m_viewW;
    const W = this.m_worldWidth;
    if (W <= Vw) return; // no scroll → no minimap
    const Vh = this.m_viewH;
    const r = this.minimapRect();
    const {m, width, height} = r;
    const sx = width / W; // world → minimap X
    const sy = height / Vh; // world → minimap Y (Y doesn't scroll; worldH = viewH)

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    // Panel: translucent white plate (α 0x40) with a black frame (α 0xff).
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(m, m, width, height);

    // Extents box: the slice of the world currently on screen (α 0x80).
    const boxX = Math.round(this.m_camX * sx);
    const boxW = Math.round(Vw * sx);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(m + boxX, m, boxW, height);

    // Terrain silhouette: one down-sampled black column per minimap pixel, from the
    // surface down to the strip bottom (α 0x80).
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let col = 0; col < width; col++) {
      const worldX = Math.floor((col * W) / width);
      const surfY = clamp(this.m_land.getHeightAt(worldX), 0, Vh);
      const y = Math.round(surfY * sy) + m;
      ctx.fillRect(m + col, y, 1, m + height - y);
    }

    // Frames: extents box outline then the panel frame, both crisp 1px.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeRect(m + boxX + 0.5, m + 0.5, boxW, height - 1);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(m + 0.5, m + 0.5, width, height);

    // Tank dots: filled square in the tank's team colour; active player outlined white.
    const d = 2;
    const cur = this.getCurrentTank();
    for (const t of this.m_tanks) {
      if (!t.isAlive()) continue;
      const p = t.getPosition();
      const dx = Math.round(clamp(p.x * sx + m, m + d, m + width - d));
      const dy = Math.round(clamp(p.y * sy + m, m + d, m + height - d));
      ctx.fillStyle = t.getColor();
      ctx.fillRect(dx - d, dy - d + 1, d * 2, d * 2);
      if (t === cur) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(dx - d - 0.5, dy - d + 0.5, d * 2 + 1, d * 2 + 1);
      }
    }
    ctx.restore();
  }

  /**
   * How far (as a fraction of view width) the top-left status text must shift right
   * to clear the minimap — 0 when there's no minimap. In the original the per-tank
   * life lines sit to the RIGHT of the overview strip.
   */
  getMinimapRightFrac(): number {
    if (this.m_worldWidth <= this.m_viewW) return 0;
    const r = this.minimapRect();
    return (r.m + r.width + 6) / this.m_viewW;
  }

  /** True when scene-pixel (px, py) is inside the minimap strip (false if no minimap). */
  hitMinimap(px: number, py: number): boolean {
    if (this.m_worldWidth <= this.m_viewW) return false;
    const r = this.minimapRect();
    return px >= r.m && px <= r.m + r.width && py >= r.m && py <= r.m + r.height;
  }

  /**
   * True when scene-pixel (px, py) is inside the minimap's extents box — the
   * draggable viewport handle (the translucent rectangle). This is what shows the
   * grab cursor and starts a pan; the rest of the strip is inert.
   */
  hitMinimapBox(px: number, py: number): boolean {
    if (this.m_worldWidth <= this.m_viewW) return false;
    const r = this.minimapRect();
    const sx = r.width / this.m_worldWidth;
    const boxX = r.m + this.m_camX * sx;
    const boxW = this.m_viewW * sx;
    return px >= boxX && px <= boxX + boxW && py >= r.m && py <= r.m + r.height;
  }

  /**
   * Drag/click the minimap to pan: a scene-pixel X on the strip snaps the camera so
   * the picked world column is centred (`camX = ((mouseX − m)/width)·W − viewWidth/2`,
   * clamped). Instant (no easing) and sets the manual-scroll override so auto-follow
   * yields until the next fire/turn.
   */
  panFromMinimap(px: number): void {
    if (this.m_worldWidth <= this.m_viewW) return;
    const r = this.minimapRect();
    const cam = ((px - r.m) / r.width) * this.m_worldWidth - this.m_viewW * CAMERA_CENTER;
    this.m_camX = this.m_camTargetX = this.clampCamX(cam);
    this.m_manualScroll = true;
    this.markDirty();
  }

  /**
   * Minimap strip rect (px) — top-left, ~half the view wide (`width = viewWidth/2 − 19`).
   * For a wide (>320) view the strip is 48px tall, or 64px at large-display scale. Our
   * canvas is always a large display, so we take the 64px height — 48 leaves the strip
   * over-elongated.
   */
  private minimapRect(): {m: number; width: number; height: number} {
    const Vw = this.m_viewW;
    const m = Vw < 240 ? 2 : Vw > 320 ? 4 : 3;
    const height = Vw < 240 ? 24 : Vw > 320 ? 64 : 29;
    const width = Math.floor(Vw / 2 - (Vw < 240 ? 8 : 19));
    return {m, width, height};
  }

  /**
   * Off-screen shot indicators — the "notch" markers (gated on the "Tracking"
   * graphics option). For every live projectile outside the view we draw an edge
   * marker: a top arrow at the shot's X when it's above the ceiling (pointing up
   * while it rises, down once it's descending), and a left/right bracket at the
   * shot's Y when it's off that side. Drawn in screen space: the shot's screen X is
   * its world X minus the camera, so on large maps the notch tracks a shot that has
   * scrolled off either side of the view.
   */
  private drawShotNotches(ctx: CanvasRenderingContext2D): void {
    const live = this.m_shots.filter(s => !s.isDead());
    if (live.length === 0) return;
    const W = this.m_viewW,
      H = this.m_viewH;
    const up = this.m_assets.getSprite('gui/notch-center'); // rising  → arrow up
    const down = this.m_assets.getSprite('gui/notch-decent'); // falling → arrow down
    const left = this.m_assets.getSprite('gui/notch-left');
    const right = this.m_assets.getSprite('gui/notch-right');
    const clampY = (y: number, h: number) => clamp(y, 0, H - h);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const shot of live) {
      const p = shot.getPosition();
      const v = shot.getVelocity();
      const sx = p.x - this.m_camX; // world → screen X (Y doesn't scroll)
      // Above the ceiling: top arrow at the shot's X (+y is downward, so v.y >= 0
      // means it's on the way down → the "descent" arrow).
      if (p.y < 0) {
        const s = v.y >= 0 ? down : up;
        if (s) ctx.drawImage(s.bitmap, Math.round(sx - s.width / 2), 0);
      }
      // Off the left / right edge: a bracket at the shot's Y, clamped into the view.
      if (sx < 0 && left) {
        ctx.drawImage(left.bitmap, 0, clampY(Math.round(p.y - left.height / 2), left.height));
      }
      if (sx > W && right) {
        ctx.drawImage(
          right.bitmap,
          W - right.width,
          clampY(Math.round(p.y - right.height / 2), right.height),
        );
      }
    }
    ctx.restore();
  }

  /** Mines, sentries and tracer markers placed on the field. */
  private drawPlacedEntities(ctx: CanvasRenderingContext2D): void {
    // Placed mines: the real spiked-mine sprite (weapons/mine.bmp), scaled to the
    // weapon's display `size` like its in-flight projectile and sat on the ground.
    for (const m of this.m_mines) {
      const weapon = getWeapon(m.weaponIndex);
      const sprite = this.m_assets.getSprite(`weapons/${weapon.getBitmap()}`);
      if (sprite) {
        const target = Math.max(6, weapon.getSize() * GameConfig.tankSizeScale);
        const k = target / Math.max(sprite.width, sprite.height);
        const dw = sprite.width * k,
          dh = sprite.height * k;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sprite.bitmap, Math.round(m.x - dw / 2), Math.round(m.y - dh + 2), dw, dh);
      } else {
        // Fallback until the sprite loads: a small dot.
        ctx.fillStyle = '#b0b0b0';
        ctx.beginPath();
        ctx.arc(m.x, m.y - 4, 4, 0, TWO_PI);
        ctx.fill();
      }
    }
    // Tracer ranging markers: a persistent white pin at the impact with a centred NUMBER
    // above it (the range), matching the original's numbered ranging label.
    for (const mk of this.m_aimMarkers) {
      ctx.save();
      // white pin (stem + head) on a thin black backing so it reads over any terrain
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(mk.x, mk.y);
      ctx.lineTo(mk.x, mk.y - 14);
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(mk.x, mk.y - 14, 2.4, 0, TWO_PI);
      ctx.fill();
      if (mk.label) {
        // Ranging number in the game's outlined bitmap font (its baked outline keeps
        // it legible over any terrain), replacing the old canvas monospace text.
        this.drawBmpCentered(ctx, 'beijing-16-out', mk.label, mk.x, mk.y - 22);
      }
      ctx.restore();
    }
  }

  /** Blit a bitmap-font string centred at world (cx, cy) at native size. */
  private drawBmpCentered(
    ctx: CanvasRenderingContext2D,
    font: FontId,
    text: string,
    cx: number,
    cy: number,
    alpha = 1,
  ): void {
    const cv = getFont(font).renderCached(text);
    if (!cv.width) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, Math.round(cx - cv.width / 2), Math.round(cy - cv.height / 2));
    ctx.restore();
  }

  /**
   * Floating "Show Points" damage numbers — on a
   * damaging hit, a number rises off the struck tank and fades. Drawn in world space
   * (under the camera) in an outlined bitmap font.
   */
  private drawDamageNumbers(ctx: CanvasRenderingContext2D): void {
    for (const d of this.m_damageNumbers) {
      const t = d.age / DMG_NUM_LIFE;
      this.drawBmpCentered(ctx, 'beijing-16-out', d.text, d.x, d.y - t * DMG_NUM_RISE, 1 - t);
    }
  }

  /** Show Blast Circles: a fading ring at each explosion's damage radius. */
  private drawBlastCircles(ctx: CanvasRenderingContext2D): void {
    for (const c of this.m_blastCircles) {
      const a = Math.max(0, 1 - c.age / BLAST_CIRCLE_LIFE);
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(0,0,0,${0.5 * a})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, TWO_PI);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, TWO_PI);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Spawn a Show-Points damage number off `tank` (jittered like the original). */
  private spawnDamageNumber(tank: CTank, amount: number): void {
    if (!GameConfig.showPoints || amount < 1) return;
    const p = tank.getPosition();
    this.m_damageNumbers.push({
      x: p.x + (Math.random() * 40 - 20),
      y: p.y + (Math.random() * 24 - 12),
      text: String(Math.round(amount)),
      age: 0,
    });
  }

  // ========================================================================
  // TAUNTS (Chatter) — contextual speech bubbles. Category is driven by the
  // event (post-fire / death / idle); the line is a uniform random pick inside
  // that category (see core/CTaunts). Rendered as DOM overlays (App → TauntLayer).
  // ========================================================================

  /** Try to make `speaker` say a `cat` line: gated by the Chatter setting, the
   *  Sentry exclusion, a live speaker, and a `chancePct` roll. On success a bubble
   *  replaces any this speaker already has. */
  private tryTaunt(cat: TauntCategory, speaker: CTank | null, chancePct: number): void {
    if (!GameConfig.chatter || !speaker) return;
    // A dead tank speaks ONLY its death line — never an idle/gloat 'taunt' (which would overwrite the
    // death cry via the same-speaker filter below). Death cat is called from handleTankDestroyed after
    // the tank is already marked dead, so it must be exempt from the alive check.
    if (cat !== 'death' && !speaker.isAlive()) return;
    if (speaker.isSentry()) return; // Sentries never taunt
    if (Math.random() * 100 > chancePct) return;
    const line = pickTaunt(cat);
    if (!line) return; // list emptied in the editor → nothing to say
    this.m_bubbles = this.m_bubbles.filter(b => b.speaker !== speaker);
    this.m_bubbles.push({
      id: ++this.m_bubbleSeq,
      speaker,
      text: fmt(strings.value.game.bubble, {name: speaker.getName(), line}),
      age: 0,
    });
  }

  /** The manual "Chat Taunt" key (bound to Enter): the human's current tank always
   *  speaks an idle-taunt line (a deliberate press, so no chance roll). */
  playerTaunt(): void {
    if (this.m_paused) return;
    const tank = this.getCurrentTank();
    if (tank.isHuman() && tank.isAlive()) this.tryTaunt('taunt', tank, 100);
  }

  /** Age bubbles (dropping the expired) and run the idle-taunt countdown, which only
   *  ticks while a live tank is waiting to fire (no shot in flight). */
  private updateTaunts(dt: number): void {
    // Age bubbles out — EXCEPT on the standings screen, where the victor's gloat bubble must persist
    // beside the winner flag until the player advances (clearTaunts). It's created in finishBattle, so
    // ageing it here would let it vanish after TAUNT_LIFE seconds mid-celebration.
    if (this.m_gameState !== EGameState.BattleEnd && this.m_bubbles.length) {
      for (const b of this.m_bubbles) b.age += dt;
      this.m_bubbles = this.m_bubbles.filter(b => b.age < TAUNT_LIFE);
    }
    if (this.m_gameState !== EGameState.Battle) return; // only during a live turn
    this.m_tauntTimer -= dt;
    if (this.m_tauntTimer <= 0) {
      this.tryTaunt('taunt', this.getCurrentTank(), TAUNT_CHANCE_IDLE);
      this.m_tauntTimer = TAUNT_IDLE_MIN + Math.random() * (TAUNT_IDLE_MAX - TAUNT_IDLE_MIN);
    }
  }

  /** Active taunt bubbles projected to fractional screen coords (0..1 of the view),
   *  so the DOM overlay tracks the speaker as the camera scrolls. `alpha` fades the
   *  bubble over its final TAUNT_FADE seconds. */
  getActiveTaunts(): ActiveTaunt[] {
    if (!this.m_bubbles.length) return [];
    const vw = this.m_viewW,
      vh = this.m_viewH;
    return this.m_bubbles.map(b => {
      const p = b.speaker.getPosition();
      const remain = TAUNT_LIFE - b.age;
      return {
        id: b.id,
        text: b.text,
        xPct: (p.x - this.m_camX) / vw,
        yPct: (p.y - TAUNT_RISE) / vh,
        alpha: clamp01(remain / TAUNT_FADE),
      };
    });
  }

  /**
   * The drag-aim indicator: a hollow green block-arrow from the tank toward the aim
   * point (no fill). Its length is capped at full power, and its thickness + head
   * grow with power. The target crosshair sits exactly at the tip.
   */
  private drawAim(ctx: CanvasRenderingContext2D): void {
    if (!this.m_aim.active) return;
    // The arrow starts at the cannon tip (muzzle). Since the aim angle is measured from
    // the turret pivot, the muzzle lies on the pivot→aim ray, so the arrow runs collinear
    // with the barrel. (The crosshair markers still anchor to the pivot via aimPoint(), so
    // the faded "initial" marker stays put while aiming.)
    const o = this.getCurrentTank().getMuzzlePosition();
    // The tip is the COMMITTED aim point — the very point the target cross marks
    // (aimPoint of the live angle/power) — not the raw cursor. Below full power they
    // coincide, so the tip still tracks the cursor; past it they don't, and drawing to
    // the cursor put the tip a barrel-length BEYOND the cross: the cursor distance was
    // capped from the muzzle (pivot + barrel + 400) while the aim point caps from the
    // pivot (pivot + 400). Deriving both from aimPoint() keeps them exactly together,
    // and also shows the whole-degree angle the shot actually commits to.
    const t = this.aimPoint(this.m_angle, this.m_power);
    const dx = t.x - o.x,
      dy = t.y - o.y;
    const ang = Math.atan2(dy, dx);
    // The whole shape scales with length (thickness too).
    const L = Math.hypot(dx, dy);

    // Block-arrow shape: base half 1, shaft-junction half 1.5, head half 4,
    // junction at 10/15, tip at 15 — all in units of L/15.
    const sh0 = L * (1 / 15); // base half-width
    const sh1 = L * (1.5 / 15); // shaft-junction half-width
    const hw = L * (4 / 15); // head half-width
    const jn = L * (10 / 15); // shaft/head junction
    const pts: [number, number][] = [
      [0, -sh0],
      [jn, -sh1],
      [jn, -hw],
      [L, 0],
      [jn, hw],
      [jn, sh1],
      [0, sh0],
    ];

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.translate(o.x, o.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.lineJoin = 'round';
    // Pure-green line (0x00ff00) over a black backing, no fill.
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * When a Move utility (extType 3) is selected on the human's turn, highlight the valid move
   * AREA — a translucent green band hugging the terrain within `[tankX ± budget]` (budget =
   * `moveRange`). This is the original's "Click in the green area to move" region; the tank
   * walks to the point you aim at inside it.
   */
  private drawMoveArea(ctx: CanvasRenderingContext2D): void {
    if (this.m_gameState !== EGameState.Battle) return;
    if (this.m_moveResolving) return; // a placed move is resolving → never flash the band back
    const tank = this.getCurrentTank();
    if (!tank.isAlive() || !tank.isHuman()) return;
    if (tank.isMoving()) return; // the drive has started (spot clicked) → hide the band + hint
    const weapon = getWeapon(this.m_currentWeaponIndex);
    if (weapon.getExtType() !== EXT.MOVE) return;
    const budget = this.moveRange(weapon);
    const tx = tank.getPosition().x;
    const x0 = Math.max(0, Math.floor(tx - budget)),
      x1 = Math.min(this.m_worldWidth - 1, Math.ceil(tx + budget));
    if (x1 <= x0) return;

    // Once FIRE arms placement, the band brightens and gains an outline (and a hint below) — the cue
    // to click a spot inside it; before that it's a faint preview of where the tank may go.
    const placing = this.m_movePlacing;
    ctx.save();
    ctx.globalAlpha = placing ? 0.42 : 0.2;
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.moveTo(x0, this.m_land.getHeightAt(x0));
    for (let x = x0; x <= x1; x++) ctx.lineTo(x, this.m_land.getHeightAt(x)); // along the surface
    for (let x = x1; x >= x0; x--) ctx.lineTo(x, this.m_land.getHeightAt(x) - 26); // up 26px = the band
    ctx.closePath();
    ctx.fill();
    if (placing) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = '#b6ffb6';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();

    if (placing) this.drawMoveHint(ctx, x0, x1, tx);
  }

  /** The "click to move here" hint that follows the pointer while placing a Move. Drawn as a small
   *  captioned chip above the terrain at the cursor column (clamped to the band). */
  private drawMoveHint(ctx: CanvasRenderingContext2D, x0: number, x1: number, tankX: number): void {
    const cx = this.m_mouse.x >= 0 ? clamp(this.m_mouse.x, x0, x1) : tankX;
    const surfY = this.m_land.getHeightAt(Math.round(cx));
    const label = strings.value.game.moveHint;
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width + 14;
    const boxY = surfY - 44;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#0a2a0a';
    ctx.strokeStyle = '#b6ffb6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(cx - w / 2, boxY - 9, w, 18);
    ctx.fill();
    ctx.stroke();
    // A downward marker line from the chip to the destination surface.
    ctx.beginPath();
    ctx.moveTo(cx, boxY + 9);
    ctx.lineTo(cx, surfY - 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e8ffe8';
    ctx.fillText(label, cx, boxY);
    ctx.restore();
  }

  /** Is the human currently placing a Move (FIRE armed, awaiting a click on the band)? */
  isMovePlacing(): boolean {
    return this.m_movePlacing;
  }

  /** Commit a placed Move: drive the current tank to the clicked world-X (clamped to the move
   *  budget), consuming the round and ending the turn — the click-to-place counterpart of firing. */
  placeMove(worldX: number): void {
    if (!this.m_movePlacing) return;
    this.m_movePlacing = false;
    const tank = this.getCurrentTank();
    // A buried tank can't drive — refuse the placement without consuming the Move or ending the turn.
    if (this.m_paused || !tank.isAlive() || tank.isMoving() || !tank.isHuman() || tank.isBuried())
      return;
    const weapon = getWeapon(this.m_currentWeaponIndex);
    if (weapon.getExtType() !== EXT.MOVE) return;

    // Consume the move round (a Move is a finite utility; Shell/free-fire make consume a no-op),
    // then drive to the clamped destination. No ensureStocked — the human selected Move in stock.
    if (!GameConfig.demo) this.economyFor(tank).consume(this.m_currentWeaponIndex);
    const budget = this.moveRange(weapon);
    const tx = tank.getPosition().x;
    const destX = clamp(worldX, tx - budget, tx + budget);
    // NET: relay the destination so peers drive the tank to the SAME X (deterministic — the drive
    // settles at destX). Without this, the tank only moves on the actor's client; peers keep it at the
    // old X, and the turn-end snapshot (detect-only once simulating) then flags a permanent desync.
    if (this.m_netMode && this.isLocalNetTurn()) this.m_onNetCommand?.({t: 'move', destX});
    this.m_turnTimerRunning = false;
    this.m_manualScroll = false;
    this.m_firedThisTurn = false; // a move isn't a shot → no post-fire gloat
    this.startTankMove(tank, destX);
  }

  /** Cancel an armed Move placement (weapon change, turn change, pause) — the band goes back to preview. */
  private cancelMovePlacing(): void {
    if (this.m_movePlacing) {
      this.m_movePlacing = false;
      this.markDirty();
    }
  }

  /** World point the current (angle, power) aims at — where the target cross sits. */
  private aimPoint(angleDeg: number, power: number): Vec2 {
    const o = this.aimOrigin();
    const r = deg2rad(angleDeg);
    const f = Math.max(0, (power - 10) / 990); // POWER_MIN..MAX → 0..1
    const L = f * CGameController.AIM_MAX_DRAG; // = the arrow tip (drag distance, capped)
    return new Vec2(o.x + Math.cos(r) * L, o.y - Math.sin(r) * L); // screen-Y up = -sin
  }

  /**
   * The target crosshair marking the aim point of the (power, angle) tuple. Shown
   * whenever it's a human's turn: a faded "initial" cross at the turn-start aim and
   * a solid "current" cross at the live aim — so you can see how you've adjusted.
   */
  private drawAimTarget(ctx: CanvasRenderingContext2D): void {
    if (this.m_gameState !== EGameState.Battle || !this.isPlayerTurn()) return;
    // A Move utility isn't aimed by angle/power — its destination is a click on the green band, so
    // suppress the aim reticle/arrows entirely (the move area + its hint are the only cue).
    if (getWeapon(this.m_currentWeaponIndex).getExtType() === EXT.MOVE) return;

    // The "target turret" reticle sprite, centred on the aim point.
    // Falls back to a drawn white/grey "+" until the sprite has loaded.
    const sprite = this.m_assets.getSprite('gui/target');
    const cross = (p: Vec2, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      if (sprite) {
        const s = 13;
        ctx.drawImage(sprite.bitmap, Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
      } else {
        const arm = 6,
          gap = 2;
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(p.x - arm, p.y);
          ctx.lineTo(p.x - gap, p.y);
          ctx.moveTo(p.x + gap, p.y);
          ctx.lineTo(p.x + arm, p.y);
          ctx.moveTo(p.x, p.y - arm);
          ctx.lineTo(p.x, p.y - gap);
          ctx.moveTo(p.x, p.y + gap);
          ctx.lineTo(p.x, p.y + arm);
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2.5;
        path();
        ctx.stroke();
        ctx.strokeStyle = '#e6e6e6';
        ctx.lineWidth = 1;
        path();
        ctx.stroke();
      }
      ctx.restore();
    };

    // Faded marker at the turn's initial power/angle (Graphics → Show Last Aim).
    if (GameConfig.showLastAim)
      cross(this.aimPoint(this.m_turnStartAngle, this.m_turnStartPower), 0.35);
    // While dragging, the arrow's tip already marks the current aim — hide the
    // active cross and show it again on release.
    if (!this.m_aim.active) cross(this.aimPoint(this.m_angle, this.m_power), 1);
  }

  /** Background stars for atmosphere. */
  private drawStars(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#ffffff';

    // Static stars (seeded random)
    const starPositions = [
      [50, 30],
      [150, 60],
      [300, 25],
      [450, 80],
      [600, 40],
      [700, 55],
      [100, 100],
      [250, 120],
      [500, 90],
      [650, 110],
    ];

    for (const [x, y] of starPositions) {
      ctx.globalAlpha = 0.3 + Math.sin(Date.now() / 1000 + x) * 0.2;
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, TWO_PI);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  /** The winner flag (between battles): a red flag on a wooden pole that RISES up out
   *  of the terrain, then WAVES with a moving sheen — drawn procedurally. */
  private drawWinnerFlag(ctx: CanvasRenderingContext2D): void {
    const tank = this.getWinnerTank();
    if (!tank) return;
    const pos = tank.getPosition();
    const r = tank.getHitRadius();
    // Plant on the side with screen room: if the tank sits on the RIGHT half of the view, put the
    // pole to its LEFT (dir=-1) so the flag can't run off the right edge and hide; otherwise to its
    // right. The cloth is mirrored by `dir` below so it always hangs AWAY from the hull.
    const dir = pos.x - this.m_camX > this.m_viewW / 2 ? -1 : 1;
    const fx = pos.x + dir * (r + 30); // pole a little clear of the hull, on the roomy side
    // Plant the pole ON the terrain (a hair below the surface so it doesn't float),
    // sampling the ground column right under the pole.
    const base = this.m_land.getHeightAt(fx) + 2;
    const poleH = r * 3.6; // full pole height above ground
    const fw = r * 2.0; // flag size
    const fh = r * 1.25;

    // Rise: the whole pole (with the flag at its top) grows up out of the ground over
    // RAISE seconds (ease-out); after that it just waves. Slower than a flick so the
    // raise reads as a deliberate planting.
    const RAISE = 1.8;
    const raise = Math.min(1, this.m_battleEndTime / RAISE);
    const ease = 1 - (1 - raise) * (1 - raise);
    const poleTop = base - poleH * ease; // current top of the growing pole
    const flagTop = poleTop + 1; // flag hangs just under the finial
    const phase = this.m_battleEndTime * 7; // wave speed (unchanged)
    const amp = fh * 0.16 * ease; // no flutter until it's up

    ctx.save();
    // Wooden pole (grows from the ground to poleTop) + a small cap finial.
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#7a4f2a'; // wood brown
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(fx, base);
    ctx.lineTo(fx, poleTop);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,225,190,0.5)'; // left-edge highlight for a rounded pole
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(fx - 0.7, base);
    ctx.lineTo(fx - 0.7, poleTop);
    ctx.stroke();
    ctx.fillStyle = '#5a3a1e';
    ctx.beginPath();
    ctx.arc(fx, poleTop, 2.2, 0, TWO_PI);
    ctx.fill();

    // Waving red flag: each vertical strip is offset by a sine that grows toward the
    // free (right) edge, and SHADED by the wave's local slope so light plays across the
    // cloth as it ripples — crests catch the light, troughs fall into shadow.
    const N = 14;
    const waveAt = (t: number) => Math.sin(t * TWO_PI - phase) * amp * t;
    const clamp255 = (v: number) => clamp(Math.round(v), 0, 255);
    for (let i = 0; i < N; i++) {
      const t0 = i / N,
        t1 = (i + 1) / N;
      const mid = (t0 + t1) / 2;
      // Sheen from the wave's slope (∝ cos of the sine's argument): +1 face-to-light → lit.
      const shade = Math.cos(mid * TWO_PI - phase) * mid; // stronger toward free edge
      const l = 0.82 + 0.42 * shade; // brightness multiplier
      ctx.fillStyle = `rgb(${clamp255(224 * l)},${clamp255(34 * l)},${clamp255(34 * l)})`;
      ctx.beginPath();
      ctx.moveTo(fx + dir * fw * t0, flagTop + waveAt(t0));
      ctx.lineTo(fx + dir * (fw * t1 + 0.5), flagTop + waveAt(t1)); // +0.5 overlap hides seams
      ctx.lineTo(fx + dir * (fw * t1 + 0.5), flagTop + fh + waveAt(t1));
      ctx.lineTo(fx + dir * fw * t0, flagTop + fh + waveAt(t0));
      ctx.closePath();
      ctx.fill();
    }
    // Thin dark outline along the top + bottom edges for definition.
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fx, flagTop);
    for (let i = 1; i <= N; i++) ctx.lineTo(fx + dir * fw * (i / N), flagTop + waveAt(i / N));
    ctx.moveTo(fx, flagTop + fh);
    for (let i = 1; i <= N; i++) ctx.lineTo(fx + dir * fw * (i / N), flagTop + fh + waveAt(i / N));
    ctx.stroke();
    ctx.restore();
  }

  // ========================================================================
  // VICTORY FIREWORKS (war end, human wins)
  // ========================================================================

  /** True when the war is over AND the human's team leads the final standings — the
   *  only case the legacy fires victory fireworks. Leader is mode-aware (Deathmatch: kills;
   *  Rounds/Points: points), via getLeadingTeam — so a points win with no survivors still
   *  counts. */
  private isHumanWarVictory(): boolean {
    if (!this.getWarOver()) return false;
    if (!this.m_tanks.some(t => t.isHuman())) return false;
    return this.getLeadingTeam()?.human ?? false;
  }

  /** Launch a firework: pick a random sky target above the terrain and send a rocket up
   *  from the ground toward it (it detonates into the burst on arrival). */
  private launchFirework(): void {
    if (!burstPixels.some(Boolean)) {
      loadBurstPixels(); // shapes not sampled yet — kick off the load and skip this beat
      return;
    }
    const vw = this.m_viewW;
    const margin = 32 * FW_SCALE; // keep the whole 64px burst on screen
    const cx = this.m_camX + margin + Math.random() * Math.max(1, vw - 2 * margin);
    const ground = this.m_land.getHeightAt(cx); // terrain surface — the launch pad
    const ceil = Math.max(24, ground - 24);
    const targetY = 14 + Math.random() * ceil * 0.5; // upper sky
    this.m_rockets.push({x: cx, y: ground, vy: -FW_ROCKET_SPEED, targetY});
  }

  /** Detonate a burst at (cx, cy): one spark per lit pixel of a random burst bmp, coloured
   *  by that pixel, flying radially out at a uniform-random speed (rand01 × scale). */
  private explodeFirework(cx: number, cy: number): void {
    const ready = burstPixels.filter((p): p is {dx: number; dy: number; color: string}[] => !!p);
    if (!ready.length) return;
    const pts = ready[Math.floor(Math.random() * ready.length)];
    for (const p of pts) {
      const dist = Math.hypot(p.dx, p.dy) || 1;
      const sp = Math.random() * FW_SPEED; // uniform radial speed (rand01 × scale)
      this.m_fireworks.push({
        x: cx + p.dx * FW_SCALE,
        y: cy + p.dy * FW_SCALE,
        vx: (p.dx / dist) * sp,
        vy: (p.dy / dist) * sp,
        color: p.color, // the bmp pixel's own colour
        age: 0,
        life: FW_LIFE * (0.8 + Math.random() * 0.4),
      });
    }
    this.m_audio?.firework(cx); // Slapthunder1/2.wav (the boom); pan spans the WORLD, so pass world-X
  }

  /** Tick the victory fireworks: launch on the interval, rise the rockets (trailing
   *  sparks) until they detonate, then integrate every spark (gravity + wind drift ×0.7),
   *  dropping the expired / grounded / off-view. */
  private updateFireworks(dt: number): void {
    if (!this.m_showFireworks) return;
    this.m_fireworkTimer -= dt;
    if (this.m_fireworkTimer <= 0) {
      this.launchFirework();
      this.m_fireworkTimer = FW_INTERVAL_MIN + Math.random() * (FW_INTERVAL_MAX - FW_INTERVAL_MIN);
    }
    const wx = this.m_effWind.x * 0.7,
      wy = this.m_effWind.y * 0.7;

    // Rockets: rise, trail a spark each frame, detonate on reaching the target.
    if (this.m_rockets.length) {
      const rising: FwRocket[] = [];
      for (const r of this.m_rockets) {
        r.y += r.vy * dt;
        r.x += wx * dt * 0.3; // slight wind lean
        this.m_fireworks.push({
          x: r.x + plusMinus(1.5),
          y: r.y + Math.random() * 4, // just below the head
          vx: plusMinus(8),
          vy: plusMinus(8) + 6,
          color: 'rgb(255,226,150)', // warm launch spark
          age: 0,
          life: FW_TRAIL_LIFE * (0.6 + Math.random() * 0.6),
        });
        if (r.y <= r.targetY) this.explodeFirework(r.x, r.targetY);
        else rising.push(r);
      }
      this.m_rockets = rising;
    }

    // Burst + trail sparks: integrate, then cull. The shared wind profile (core/wind.ts)
    // eases the drift near the ground in Realistic mode (constant 1 in Linear), so low sparks
    // fall straighter while high bursts stream with the wind.
    if (this.m_fireworks.length) {
      for (const p of this.m_fireworks) {
        const wf = windProfile(this.m_land.getHeightAt(p.x) - p.y);
        p.age += dt;
        p.vx += wx * wf * dt;
        p.vy += (FW_GRAVITY + wy * wf) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      this.m_fireworks = this.m_fireworks.filter(
        p => p.age < p.life && p.y < this.m_land.getHeightAt(p.x),
      );
    }
  }

  /** Draw the fireworks as small glowing sparks coloured by the burst pixel. Additive
   *  ('lighter') so they read as bright fireworks on any sky (the legacy screenshots show
   *  bright, glowing sparks — the raw disc primitive is nominally alpha-blended, but the
   *  particles render as flares). Alpha holds full for the first FW_HOLD of life, then
   *  falls linearly to 0. A brighter core over a soft glow gives each spark some bloom. */
  private drawFireworks(ctx: CanvasRenderingContext2D): void {
    if (!this.m_fireworks.length && !this.m_rockets.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Fine sparks: a 1px bright core over a faint 2px bloom.
    for (const p of this.m_fireworks) {
      const t = p.age / p.life;
      const alpha = t <= FW_HOLD ? 1 : 1 - (t - FW_HOLD) / (1 - FW_HOLD);
      if (alpha <= 0) continue;
      const x = Math.round(p.x),
        y = Math.round(p.y);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha * 0.4;
      ctx.fillRect(x - 1, y - 1, 2, 2); // faint bloom
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, 1, 1); // 1px core
    }
    // Rocket heads: a bright warm streak climbing to the burst.
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgb(255,240,200)';
    for (const r of this.m_rockets) {
      ctx.fillRect(Math.round(r.x) - 1, Math.round(r.y), 2, 3);
    }
    ctx.restore();
  }

  // ========================================================================
  // SUPPLY CRATES (Gameplay → Crates)
  // ========================================================================

  /** Once per ROUND (turn order wrapped), roll the Crates chance and — if the field isn't full (max
   *  2 × live tanks) — drop one parachute crate from the top at a random column. */
  private maybeSpawnCrate(): void {
    if (GameConfig.crateChance <= 0) return;
    if (this.m_rng.float() * 100 >= GameConfig.crateChance) return;
    const aliveTanks = this.m_tanks.filter(t => t.isAlive()).length;
    if (this.m_crates.length >= 2 * aliveTanks) return;
    this.addCrate(10 + this.m_rng.float() * Math.max(1, this.m_worldWidth - 20));
  }

  /** Push one crate dropping from the top at column `x`, with contents rolled 50% weapon
   *  / 20% credits / 20% health / 10% bomb (or a forced `kind` for dev previews). */
  private addCrate(x: number, forced?: CrateKind): void {
    const roll = this.m_rng.float() * 100;
    const kind: CrateKind =
      forced ?? (roll < 50 ? 'weapon' : roll < 70 ? 'credits' : roll < 90 ? 'health' : 'bomb');
    let amount = 0,
      weaponIndex = -1;
    if (kind === 'weapon') weaponIndex = this.randomCrateWeapon();
    else if (kind === 'credits')
      amount = (this.m_rng.int(9) + 1) * 200; // 200..1800
    else if (kind === 'health')
      amount = (this.m_rng.int(9) + 1) * 100; // 100..900
    else weaponIndex = WEAPON_DATABASE.findIndex(w => w.id === 'bomb');
    this.m_crates.push({
      x,
      y: 0, // top of the map
      vy: 0,
      kind,
      amount,
      weaponIndex,
      landed: false,
      phase: Math.random() * 360,
      id: ++this.m_crateSeq,
    });
  }

  /** DEV: drop a crate straight onto the human tank's column so it can be previewed
   *  falling and picked up. Optional forced content kind ('weapon'|'credits'|'health'|'bomb'). */
  devDropCrate(kind?: string): void {
    const human = this.m_tanks.find(t => t.isHuman()) ?? this.m_tanks[0];
    const forced = (['weapon', 'credits', 'health', 'bomb'] as const).find(k => k === kind);
    if (human) this.addCrate(human.getPosition().x, forced);
  }

  /** A random enabled, non-staple weapon index for a weapon crate (falls back to Bomb). */
  private randomCrateWeapon(): number {
    const staple = getDefaultWeaponIndex();
    const pool: number[] = [];
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      if (i !== staple && weaponEnabled(i)) pool.push(i);
    }
    return pool.length
      ? pool[this.m_rng.int(pool.length)]
      : WEAPON_DATABASE.findIndex(w => w.id === 'bomb');
  }

  /** Per-frame crate physics: descend under the chute (constant speed), land on the
   *  terrain, and get collected by any tank within reach. Also ages pickup messages. */
  private updateCrates(dt: number): void {
    if (this.m_crates.length) {
      const survivors: Crate[] = [];
      for (const c of this.m_crates) {
        const ground = this.m_land.getHeightAt(c.x);
        if (c.y < ground) {
          if (!c.landed) {
            c.y += CRATE_DESCENT * dt; // constant chute descent
            // Realistic wind: a parachute is almost all sail, so it drifts strongly downwind. The
            // altitude profile eases the drift as it nears the ground (windProfile → 0 at the soil),
            // so it settles rather than skating along the surface. Linear mode → 0 (falls straight).
            const wf = windProfile(ground - c.y);
            c.x = clamp(c.x + this.m_effWind.x * CRATE_WIND_DRIFT * wf * dt, 0, this.m_worldWidth);
          } else {
            c.vy += CRATE_GRAVITY * dt; // detached chute → free-fall (rarely used)
            c.y += c.vy * dt;
          }
        } else {
          c.y = ground;
          c.vy = 0;
          c.landed = true;
        }
        // Pickup: any live tank whose centre is within (crate box + tank radius).
        const taker = this.m_tanks.find(t => {
          if (!t.isAlive()) return false;
          const r = CRATE_BOX / 2 + t.getHitRadius();
          return t.distanceTo(c.x, c.y) <= r;
        });
        if (taker) this.collectCrate(c, taker);
        else survivors.push(c);
      }
      this.m_crates = survivors;
    }
    if (this.m_floatTexts.length) {
      for (const f of this.m_floatTexts) f.age += dt;
      this.m_floatTexts = this.m_floatTexts.filter(f => f.age < FLOAT_TEXT_LIFE);
    }
  }

  /** Award a crate's contents to `tank` and announce it (message shown for the human). */
  private collectCrate(c: Crate, tank: CTank): void {
    let msg = '',
      color = '#ffffff';
    switch (c.kind) {
      case 'credits':
        tank.addCredits(c.amount);
        this.poolTeamCredits(tank);
        msg = fmt(strings.value.game.foundCredits, {n: c.amount});
        color = '#ffe27a';
        break;
      case 'health': {
        const gain = clamp(tank.getMaxLife() - tank.getHealth().nLife, 0, c.amount);
        tank.addLife(gain);
        msg = fmt(strings.value.game.gainedHealth, {n: gain});
        color = '#bfe9b0';
        break;
      }
      case 'weapon':
      case 'bomb':
        if (c.weaponIndex >= 0) this.economyFor(tank).grant(c.weaponIndex);
        msg = fmt(strings.value.game.foundWeapon, {weapon: getWeapon(c.weaponIndex).getName()});
        color = '#bfe9b0';
        break;
    }
    this.m_audio?.crate(c.x);
    if (tank.isHuman() && msg) {
      const p = tank.getPosition();
      this.m_floatTexts.push({x: p.x, y: p.y - 42, text: msg, color, age: 0});
    }
    this.markDirty();
  }

  /** Draw the live crates: falling ones as the wobbling parachute assembly (pendulum
   *  swing about the canopy top), landed ones as the bare crate tilted to the slope. */
  private drawCrates(ctx: CanvasRenderingContext2D): void {
    const chute = this.m_assets.getSprite('gui/crate-chute');
    const box = this.m_assets.getSprite('gui/crate');
    for (const c of this.m_crates) {
      if (!c.landed && chute) {
        const w = chute.width,
          h = chute.height;
        // Pendulum: swing the whole assembly about its canopy top. The crate box hangs
        // at the bottom, so anchor the sprite's bottom near (x, y) and rotate about top.
        const rot =
          Math.sin(deg2rad(this.m_time * CRATE_WOBBLE_SPEED + c.phase)) * deg2rad(CRATE_WOBBLE_DEG);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(c.x, c.y - h); // canopy-top pivot
        ctx.rotate(rot);
        ctx.drawImage(chute.bitmap, -w / 2, 0, w, h);
        ctx.restore();
      } else if (box) {
        const w = box.width,
          h = box.height;
        const slope = Math.atan2(
          this.m_land.getHeightAt(c.x + w / 4) - this.m_land.getHeightAt(c.x - w / 4),
          w / 2,
        );
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(c.x, c.y);
        ctx.rotate(slope); // sit flush on the terrain slope
        ctx.drawImage(box.bitmap, -w / 2, -h, w, h); // bottom edge on the ground
        ctx.restore();
      }
    }
  }

  /** Draw the floating crate-pickup messages (rising + fading), in a bitmap font. */
  private drawFloatTexts(ctx: CanvasRenderingContext2D): void {
    for (const f of this.m_floatTexts) {
      const t = f.age / FLOAT_TEXT_LIFE;
      this.drawBmpCentered(ctx, 'beijing-16-out', f.text, f.x, f.y - t * 26, 1 - t);
    }
  }

  private drawTurnIndicator(ctx: CanvasRenderingContext2D, tank: CTank): void {
    const pos = tank.getPosition();
    const sprite = this.m_assets.getSprite('gui/turn-arrow');

    // Draw the green triangle sprite so its bottom tip points at (x, y).
    const drawTri = (x: number, y: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      if (sprite) {
        const w = 16,
          h = 16;
        ctx.drawImage(sprite.bitmap, x - w / 2, y - h, w, h);
      } else {
        ctx.fillStyle = '#22e04a';
        ctx.strokeStyle = '#0a3a12';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 9, y - 12);
        ctx.lineTo(x + 9, y - 12);
        ctx.lineTo(x, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    };

    // A single green triangle bouncing over the tank's current position.
    const bob = Math.abs(Math.sin(this.m_time * 4)) * 8;
    drawTri(pos.x, pos.y - 5 - bob, 1);
  }

  // ========================================================================
  // BATTLE FLOW
  // ========================================================================

  /** Update during battle state (waiting for player input). */
  private updateBattle(dt: number): void {
    this.updateTurnTimer(dt);
    this.updateFireCharge(dt);
    this.updateMines(dt);
    this.updateTanks(dt);

    // A tank can die DURING the Battle state — from radiation fallout, or a mine
    // detonating under a settling tank — not only from a resolving shot. The shot path
    // declares the winner in the Explosion state (via endTurn); this covers those
    // passive deaths so the battle ends the instant only one side is left, instead of
    // stalling until the human fires a needless final shot.
    this.endBattleIfDecided();

    // The ACTING tank itself can die passively (radiation DOT / a mine) mid-turn, BEFORE it fires. If
    // that death leaves the battle UNDECIDED (a living teammate, or 3+ teams), endBattleIfDecided
    // above won't end anything — yet a bot/sentry has no forfeit clock and its already-scheduled
    // fire() bails on a dead tank without handing off, so the turn would never advance and the match
    // hangs. (A human would merely stall until the shot clock forfeits — or forever if shot-time is
    // off.) Force the dead actor's turn to end. Guarded to Battle: if the death DID decide the battle,
    // endBattleIfDecided already flipped state to BattleEnd and endTurn no-ops via its own guard.
    //
    // Latch it ONCE per turn (m_turnForfeited): in net, endTurn only reports to the server and does
    // NOT advance locally, so without the latch this would re-fire every frame until the server's
    // turnBegin lands (a burst of duplicate shotResults). And drop the dead actor's already-queued
    // closures first — its scheduled fire()/executeBotTurn/waitForRest read getCurrentTank() FRESH at
    // fire time, so once endTurn advances to the next tank they'd otherwise drive the WRONG tank (a
    // premature/double shot, or a Move-drive poll racing the new turn). Mirrors finishBattle's clear.
    if (
      this.m_gameState === EGameState.Battle &&
      !this.m_turnForfeited &&
      !this.getCurrentTank().isAlive()
    ) {
      this.m_turnForfeited = true;
      this.m_timers = [];
      this.endTurn();
    }
  }

  /** Per-tank physics (gravity/fall/settle/drive/jet) + radiation damage-over-time,
   *  run EVERY frame in every in-battle state. A tank over a freshly-carved crater must
   *  begin falling within one frame — the explosion's fireball / particles / screen-shake
   *  never gate the fall (they only gate the turn hand-off). */
  private updateTanks(dt: number): void {
    // Radiation Damage OFF (legacy/faithful): fallout is purely cosmetic — the original binary
    // never damages a tank with it (only the radioactive weapon's INITIAL blast is armor-piercing,
    // wired separately via isRadioactive). ON (default): "green ground = danger", handled below.
    // NET: fallout is cosmetic-only here too. DOT is a per-frame accumulator, but the aim phase runs
    // free (not lockstep) — each client would apply a different tick count over an actor's think time
    // and drift/false-desync. So it's neutralized in net exactly as wind gusts are (the initial
    // radioactive blast, being resolved in the deterministic shot window, still lands normally).
    const zones =
      GameConfig.radiationDamage && !this.m_netMode ? this.m_land.getRadiationZones() : null;
    // The strongest live zone drives the DOT rate; fallout only exists while a zone is live.
    let radDps = 0;
    if (zones) for (const z of zones) if (z.damagePerSecond > radDps) radDps = z.damagePerSecond;

    for (const tank of this.m_tanks) {
      // Gravity/physics for EVERY tank, INCLUDING a destroyed wreck — a dead tank over a freshly
      // carved crater must fall into it just like a live one (it was being skipped, so wrecks hung
      // in mid-air). A dead tank takes no radiation and no turn logic — that's gated just below.
      tank.update(this.m_land, dt);
      if (!tank.isAlive()) continue;

      // Radiation fallout DAMAGE-OVER-TIME: a tank standing on the visible fallout carpet takes the
      // live zone's irDmg/sec. Keyed on the settled specks (what the player sees), not a fixed blast
      // circle — the carpet spreads wider than the crater, especially airbursts raining down a slope.
      if (radDps > 0 && this.m_land.radiationAt(tank.getPosition().x)) {
        tank.applyRadiationDamage(radDps * dt, dt);
        if (!tank.isAlive()) {
          this.handleTankDestroyed(tank);
          continue;
        }
      }
    }
  }

  /** Distinct teams that still have a living player tank. Sentries are excluded — they
   *  fight for their owner's team but don't keep it "alive" — so a lone survivor plus
   *  their own sentry is still one team. The battle is decided when this reaches ≤ 1. */
  private livingTeamCount(): number {
    const teams = new Set<number>();
    for (const t of this.m_tanks) {
      if (t.isAlive() && !t.isSentry()) teams.add(t.getTeamId());
    }
    return teams.size;
  }

  /**
   * Finalise the battle immediately when it's decided by a PASSIVE death (radiation, a
   * mine under a settling tank) rather than a resolving shot. Mode-aware, matching endTurn:
   *  • Deathmatch — decided when ≤ 1 team survives.
   *  • Rounds/Points — an elimination never ends it (only the round count does); a total
   *    wipeout still ends any mode.
   * `endTurn` re-checks the same condition, so this only ever finalises — it never skips a
   * live player's turn.
   */
  private endBattleIfDecided(): void {
    // Only while a turn is live: if the turn timer already forfeited into BattleEnd
    // earlier this tick, endTurn has run — a second call would double the jingle.
    if (this.m_gameState !== EGameState.Battle) return;
    const rounds = this.m_gameType === EGameType.Rounds;
    const teamsLeft = this.livingTeamCount();
    if (teamsLeft === 0 || (!rounds && teamsLeft <= 1)) this.endTurn();
  }

  /**
   * Update shot that is currently in flight
   */
  private updateShotInFlight(dt: number): void {
    // Tanks keep falling/settling while the shot resolves — a crater carved this frame
    // must drop its tank next frame, not wait for the shot/explosion to finish. Mines settle
    // the same way (gravity only — detonation stays in updateMines) so one over a fresh hole
    // drops in step with the ground being carved, rather than floating until play resumes.
    this.updateTanks(dt);
    this.settleMines(dt);
    const activeShots = this.m_shots.filter(s => !s.isDead());

    if (activeShots.length === 0) {
      // Between succession salvos (machine gun / gatling burst): no shot is in the
      // air yet the next salvo is still scheduled — hold in ShotFlying and wait.
      if (this.m_pendingSalvos > 0) return;
      // Nothing flying and nothing pending — wait for the explosion to finish before
      // the turn hands off (the Explosion state ends the turn once effects settle).
      this.m_shots = [];
      this.m_gameState = EGameState.Explosion;
      return;
    }

    for (const shot of activeShots) {
      // Per-frame behaviour dispatch (extType): roller/digger/airburst/beam/…
      const weapon = getWeapon(
        shot.getWeaponIndex() >= 0 ? shot.getWeaponIndex() : this.m_currentWeaponIndex,
      );

      // Fired from inside solid terrain (a buried tank whose muzzle sits below the piled-up
      // surface): detonate right at the muzzle, blasting the dirt around the tank, BEFORE the
      // first integration step — otherwise the fast shot clears the thin dirt column on frame 1
      // and flies the normal arc without ever touching the ground. Only on the spawn frame.
      if (shot.getAge() === 0 && firedIntoTerrain(shot, weapon, this)) {
        weaponDetonate(shot, weapon, this);
        continue;
      }

      shot.update(dt, this.m_effWind, this.m_windGroundAt);

      const sp = shot.getPosition();
      const sv = shot.getVelocity();
      // Rocket exhaust burns while the motor is running, then the shot coasts with no fume.
      // The original gates this purely on ascent (fume stops at apex), which means a shot fired
      // DOWNWARD — descending from frame 1 — never smokes at all. We keep the authentic apex
      // behaviour for arced shots but floor the burn at ROCKET_MIN_BURN seconds from launch, so
      // the motor emits for max(MIN_BURN, time-to-apex): downward and flat shots still get a
      // proper exhaust plume for the initial burn. Both the fume trail and the thrust flare are
      // gated on this same "motor burning" window.
      const isTracer = weapon.getExtType() === EXT.TRACER;
      const motorBurning = !shot.isMovingDown() || shot.getAge() < ROCKET_MIN_BURN;
      if (isTracer) {
        // Tracer: NO exhaust, NO smoke, NO nose flare — just a thin white streak.
        // Stationary white puffs planted along the whole path (it emits rising AND
        // descending) hang and fade, tracing a white arc across the sky.
        this.m_particles.tracerTrail(sp.x, sp.y, sv.x, sv.y, dt);
      } else {
        // Per-weapon trail (trailType 0 = none, 1 = basic, 2+ = rocket plume). Emitted
        // from the missile's REAR (exhaust), offset back along the heading so smoke pours
        // from the tail. `motorBurning` gates the rocket exhaust plume.
        const ex = shot.getExhaustPoint(weapon.getSize());
        this.m_particles.trail(
          ex.x,
          ex.y,
          weapon.getColor(),
          sv.x,
          sv.y,
          weapon.getTrailType(),
          weapon.getTrailLength(),
          dt,
          motorBurning,
        );
        // In-flight thrust flare (rockets: flareType/flareBmp) — only while the motor burns. Emitted
        // at the EXHAUST point (the rear tip `ex`), NOT the projectile centre, so the glow sits behind
        // the rocket at its nozzle instead of overlapping the middle of the sprite.
        const iff = weapon.getInFlightFlare();
        if (motorBurning && iff)
          this.m_particles.inflightFlare(
            ex.x,
            ex.y,
            `fx:${iff}`,
            1.5 + weapon.getFlareSize() * 2.5,
          );
      }
      const action = weaponFlyStep(shot, weapon, this, dt);
      if (action === 'detonate') {
        // Complete the shooter's ranging record: where its OWN primary round (generation 0) landed on
        // the GROUND — the empirical over/undershoot the next shot corrects for (the AI can't foresee
        // wind drift on a long flight). Only the FIRST ground landing after firing fills it (landedX
        // still unset), so the landing always pairs with the power that was actually fired — no in-air
        // airburst/apex detonation and no stale cross-shot data corrupt the read.
        const owner = shot.getOwner();
        const rec = owner && this.m_ultraShot.get(owner);
        if (rec && rec.landedX === undefined && shot.getGeneration() === 0) {
          const p = shot.getPosition();
          if (p.y >= this.m_land.getHeightAt(Math.floor(p.x)) - 4) rec.landedX = p.x;
        }
        weaponDetonate(shot, weapon, this);
      } else if (action === 'consumed') shot.kill();
    }

    // Include submunitions spawned this frame (so a cluster keeps the round in
    // flight until every child lands) AND any succession salvos not yet fired.
    const stillFlying = this.m_shots.some(s => !s.isDead()) || this.m_pendingSalvos > 0;
    if (stillFlying) {
      this.m_gameState = EGameState.ShotFlying;
    } else {
      // The shot (and any submunitions) have resolved — hold in the Explosion state
      // so the camera stays on the blast until the whole effect (a nuke can run for
      // seconds) finishes, THEN the turn hands off.
      this.m_shots = [];
      this.m_gameState = EGameState.Explosion;
    }
  }

  // ========================================================================
  // ShotWorld — the surface the weapon behaviours (WeaponBehavior.ts) act on
  // ========================================================================

  get land(): CLand {
    return this.m_land;
  }

  get tanks(): CTank[] {
    return this.m_tanks;
  }

  spawnShot(shot: CShot): void {
    this.m_shots.push(shot);
  }

  /** ShotWorld: gameplay random in [0,1) from the match-seeded stream (deterministic). */
  random(): number {
    return this.m_rng.float();
  }

  explode(
    x: number,
    y: number,
    scale: number,
    color?: string,
    radiusPx?: number,
    nuclear = false,
    blastPreset?: string,
    expType: ExpType = EXP.PLAIN,
    expBitmap?: string,
    deposit = false,
    isCleaner = false,
  ): void {
    this.m_lastImpactX = x; // the camera holds here while this blast animates
    this.m_impactThisTurn = true; // a blast landed → the Cinematic dwell may linger on it at hand-off
    // Show Blast Circles: a ring at the blast's damage radius, fading out.
    if (GameConfig.blastCircles && radiusPx !== undefined && radiusPx > 0) {
      this.m_blastCircles.push({x, y, r: radiusPx, age: 0});
    }
    if (color !== undefined && radiusPx !== undefined) {
      this.m_particles.blast(
        x,
        y,
        radiusPx,
        color,
        nuclear,
        blastPreset,
        expType,
        expBitmap,
        deposit,
        isCleaner,
      );
      // Stage 1: the big flash whites out the WHOLE screen (incl. the HUD) — a
      // full-viewport DOM overlay, since the game canvas can't reach the HUD layer.
      // It inherits the weapon's colour (uranium reads red, plutonium green, …).
      // Full-screen white-out is a NUKE thing in the original. A big conventional blast
      // gets a lighter half-flash (port embellishment) — but a Cleaner is an earth-remover, not a
      // fiery blast, so it never flashes.
      if (isNukeExp(expType) || nuclear) this.flashScreen(1, color ?? '#ffffff');
      else if (!isCleaner && (radiusPx ?? 0) >= BIG_BLAST_RADIUS)
        this.flashScreen(0.45, color ?? '#ffffff');
    } else this.m_particles.explode(x, y, scale);
  }

  /** Trigger the full-viewport flash (0..1) tinted by the weapon's colour. */
  flashScreen(intensity: number, color = '#ffffff'): void {
    if (intensity > this.m_screenFlash) {
      this.m_screenFlash = intensity;
      this.m_flashColor = color;
    }
  }

  getScreenFlash(): number {
    return this.m_screenFlash;
  }

  getScreenFlashColor(): string {
    return this.m_flashColor;
  }

  shake(mag: number, dur: number): void {
    this.m_screenShake.trigger(mag, dur);
  }

  hitSound(name: string, x: number): void {
    this.m_audio?.hit(name, x);
  }

  /** Route the smoke layer to the GPU compositor (null = draw it on the 2D canvas as before). */
  setSmokeSink(sink: ISmokeSink | null): void {
    this.m_smokeSink = sink;
    this.m_particles.setSmokeSink(sink);
  }

  ripple(x: number, y: number, strength: number): void {
    if (!GameConfig.explosionWaves) return; // Graphics → Explosion Waves (nuke wave)
    this.m_onImpact?.(x, y, strength);
  }

  /** Cosmetic dirt spray (ShotWorld) — straight through to the particle system. Crater ejecta that
   *  actually deposits earth goes to CLand instead; it writes the heightmap and has to stay on the
   *  match-seeded stream (see IFxSink). */
  debrisSpray(x: number, y: number, count: number, radius: number, gentle = false): void {
    this.m_particles.debrisSpray(x, y, count, radius, gentle);
  }

  /** Pixel data of a structure bitmap (bunker.bmp / wall.bmp) as a `0xAABBGGRR` view for
   *  `CLand.buildStructure`, rendered at `scale` (the original scales the structure bitmap
   *  down — it does NOT stamp it at native size, which would be a giant tower). Drawn from the
   *  magenta-keyed sprite (transparent stays alpha 0), nearest-neighbour so the key stays crisp,
   *  and cached by bmp+scale — this only runs when a player uses a Bunker/Wall utility. */
  private structureImage(
    bmp: string,
    scale: number,
  ): {width: number; height: number; data: Uint32Array} | null {
    const key = `${bmp}@${scale.toFixed(3)}`;
    const cached = this.m_structImages.get(key);
    if (cached) return cached;
    const sprite = this.m_assets.getSprite(`weapons/${bmp}`);
    if (!sprite) return null;
    const w = Math.max(1, Math.round(sprite.width * scale)),
      h = Math.max(1, Math.round(sprite.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = false; // keep the magenta key crisp (alpha stays 0 or 255)
    g.drawImage(sprite.bitmap, 0, 0, w, h);
    const id = g.getImageData(0, 0, w, h);
    const img = {width: w, height: h, data: new Uint32Array(id.data.buffer)};
    this.m_structImages.set(key, img);
    return img;
  }

  aimMarker(x: number, y: number, label?: string): void {
    this.m_aimMarkers.push({x, y, label});
    // Hard ceiling so a turn of repeated tracer volleys can never grow the list
    // without bound — drop the oldest pins past the cap (they clear on the next shot
    // anyway; this only guards a single turn's within-turn accumulation).
    if (this.m_aimMarkers.length > MAX_AIM_MARKERS) this.m_aimMarkers.shift();
    this.markDirty();
  }

  deployMine(x: number, y: number, owner: CTank | null, weaponIndex: number): void {
    // Arms after a short delay so it doesn't trigger on the tank that laid it.
    this.m_mines.push({x, y, vy: 0, owner, weaponIndex, armed: 0.6});
    this.markDirty();
  }

  /** A Sentry weapon lands → drop a stationary "Sentry" tank on the owner's team at the
   *  impact point. It's a real tank in the array: it renders with the Sentry hull/turret
   *  sprites (team-tinted), takes blast damage → wreck, and on its own turn aims its turret
   *  at the nearest enemy and fires in a direct line (Turret → Shell, Minigun → Machine Gun).
   *  Sentries are excluded from the turn's win count, standings and taunts, and are cleared
   *  at the next battle. */
  deploySentry(x: number, _y: number, owner: CTank | null, weaponIndex: number): void {
    const team = owner ? owner.getTeamId() : 0;
    // Never grow the field without bound — but count only THIS player's own turrets, so the
    // allowance is identical for everyone whether the match has 2 players or 16.
    let deployed = 0;
    for (const t of this.m_tanks) if (t.isSentry() && t.getTeamId() === team) deployed++;
    if (deployed >= MAX_SENTRIES_PER_PLAYER) return;
    const w = getWeapon(weaponIndex);
    const minigun = w.getId() === 'sentry.minigun';
    // The badge shows the OWNER's name (a sentry inherits its deployer's display name);
    // "Sentry" is only the internal TYPE — it drives the sprites + the behaviour guards
    // (turn/standings/taunt exclusions), never the on-field label.
    const sentry = new CTank(owner ? owner.getName() : strings.value.game.sentry, team);
    sentry.setTankType('Sentry'); // Sentry body/turret/wreck sprites
    if (owner) sentry.setColor(owner.getColor()); // team identity + tint
    sentry.setHuman(false);
    sentry.init(x, this.m_land); // snap onto the terrain at the impact column (_y unused)
    // Health is a FIXED per-weapon value — the deploy weapon's own magnitude (Turret 200, Minigun
    // 500) — NOT the match Hit-Points setting and NOT a ×2 for the minigun (the deploy overwrites
    // both the 1000 constructor default and the match-HP write with the weapon value).
    sentry.setMaxLife(w.getDamage());
    if (minigun) this.m_sentryMinigun.add(sentry); // → fires "Machine Gun" on its turn
    this.m_tanks.push(sentry);
    // Preload the Sentry hull/turret/wreck sprites — the startGame preload ran before this
    // tank existed, so without this the renderer would stay on the vector-hull fallback.
    for (const s of sentry.getRequiredSprites()) {
      this.m_assets.loadSprite(s.name, s.file);
    }
    this.markDirty();
  }

  /**
   * Keep deployed mines glued to the terrain: when the ground under a mine is carved away (an
   * explosion or cleaner digs a hole), the mine falls under gravity onto the new surface instead of
   * floating where it was laid — mirroring how a tank re-settles in CTank.update(). Called every
   * frame the mines are live, including during shot resolution so a mine drops in step with the
   * hole being dug (alongside the tank settling in updateShotInFlight).
   */
  private settleMines(dt: number): void {
    for (const m of this.m_mines) {
      const surf = this.m_land.getHeightAt(Math.floor(m.x));
      if (m.y < surf - 0.5) {
        // Airborne over a fresh hole — fall onto the new surface.
        m.vy += MINE_GRAVITY * dt;
        m.y += m.vy * dt;
        if (m.vy >= 0 && m.y >= surf) {
          m.y = surf;
          m.vy = 0;
        }
        this.markDirty();
      } else {
        // Resting on the surface — stay glued to it as the terrain deforms.
        if (m.y !== surf) this.markDirty();
        m.y = surf;
        m.vy = 0;
      }
    }
  }

  private updateMines(dt: number): void {
    this.settleMines(dt);
    for (let i = this.m_mines.length - 1; i >= 0; i--) {
      const m = this.m_mines[i];
      if (m.armed > 0) {
        m.armed -= dt;
        continue;
      }
      const near = this.m_tanks.find(t => t.isAlive() && t.distanceTo(m.x, m.y) < 20);
      if (!near) continue;
      const w = getWeapon(m.weaponIndex);
      this.m_mines.splice(i, 1);
      // Scale the mine blast by Explosion Size × resolution, exactly like a fired shot (a mine used
      // the raw weapon radius, so it ignored the setting and the resolution scale — now aligned).
      const mineR = this.scaledBlastRadius(w);
      this.explode(
        m.x,
        m.y,
        1.3,
        w.getColor(),
        mineR,
        w.isNuclear(),
        w.getBlastParticle(),
        w.getExpType(),
        w.getExpBitmap(),
        w.getEarth() > 0,
        w.isCleaner(),
      );
      // Only big mines shake the camera (see weaponDetonate — shake is reserved for
      // bomb/nuke-scale blasts; a small proximity charge just pops). A nuke mine gets the longer
      // rumble that outlasts its full-screen white-out (a short shake plays out behind it, unseen).
      // Gated on the Camera Shake option (a port embellishment, not in the original).
      if (GameConfig.cameraShake && w.isBigBlast(w.getRadius()))
        this.shake(w.isNukeClass() ? 16 : 8, w.isNukeClass() ? 1.0 : 0.3);
      // Unified crater: disc + gravity collapse (never strip the column) + soil-coated face.
      this.m_land.carveDiscCollapse(Math.floor(m.x), Math.floor(m.y), mineR, true, false, true);
      // Scorch is crackle-gated + scaled, matching weaponDetonate (a clean charge leaves no burn).
      const mineCrackle = w.getCrackle();
      if (mineCrackle > 0)
        this.m_land.scorch(
          Math.floor(m.x),
          Math.floor(m.y),
          Math.round(mineR * (0.4 + mineCrackle * 0.85)),
        );
      this.applyBlast(
        new Vec2(m.x, m.y),
        mineR,
        w.getDamage(),
        m.owner,
        false,
        w.isRadioactive(),
        0.5 * w.getSize(), // same inner full-damage core as a normal detonation
      );
    }
  }

  /**
   * Falloff blast damage + kick, applied through the tank's shield/armor model.
   * `full` = beam direct hit: no distance falloff.
   */
  applyBlast(
    pos: Vec2,
    radius: number,
    damage: number,
    owner: CTank | null,
    full: boolean,
    piercing = false,
    innerRadius = 0,
  ): void {
    this.m_stats.terrainCarved++; // one area blast ≈ one crater (nerdy "terrain carved" counter)
    let ownGoal = 0; // life this blast took off the shooter's OWN side (including the shooter itself)
    for (const tank of this.m_tanks) {
      if (!tank.isAlive()) continue;
      // Two-radius model (recovered from the blast routine): full damage within the inner
      // CORE, then LINEAR falloff — normalized by the OUTER radius — to zero at the outer
      // edge. Both radii get the target's own collision radius added (a target-size bonus,
      // not subtracted from distance), so a bigger tank is easier to catch. There's a
      // deliberate step DOWN at the core edge (core = flat full damage, not a smooth peak).
      const collR = tank.getHitRadius(); // target collision radius, added to both radii
      const outer = Math.max(radius, 0) + collR; // zero-damage boundary
      const inner = innerRadius + collR; // full-damage core
      const dist = tank.distanceTo(pos.x, pos.y);
      if (dist > outer) continue; // beyond the outer field → no damage

      // Beams (full) always deal full damage to what they touch; otherwise full inside the
      // core, then damage × (1 − dist/outer) out to the edge.
      const dmg = full || dist <= inner ? damage : damage * (1 - dist / outer);
      if (dmg <= 0) continue;

      const removed = tank.hit(dmg, piercing); // shield → hazmat(if piercing) → armor → life
      if (owner && removed > 0 && owner.getTeamId() === tank.getTeamId()) ownGoal += removed;
      this.creditDamage(owner, tank, removed); // shooter earns per life removed
      this.spawnDamageNumber(tank, removed); // Show Points: floating damage text
      this.kickTank(tank, pos.x, removed, radius); // Tank → Kickback; up-and-away, scaled by blast size

      if (!tank.isAlive()) this.handleTankDestroyed(tank);
    }

    // SELF-TAUNT: a round that lands on your own side is the one moment a tank has something to say
    // about ITSELF. Once per blast (not per victim), so a wide own-goal doesn't start a chorus, and
    // only when it actually hurt — a harmless graze isn't worth a line.
    if (ownGoal >= SELF_TAUNT_MIN_DAMAGE) this.tryTaunt('taunt', owner, TAUNT_CHANCE_SELF);

    // Any supply crate whose centre is within the blast is destroyed — the original
    // clears crates in the crater's radius and simply removes them (no reward is spilled,
    // no debris, no sound; the blast's own fireball is the only visual).
    if (this.m_crates.length) {
      const reach = Math.max(radius, 20) + CRATE_BOX / 2; // crater/outer-field reach
      this.m_crates = this.m_crates.filter(c => Math.hypot(c.x - pos.x, c.y - pos.y) > reach);
    }
  }

  /** Handle tank destroyed event. */
  private handleTankDestroyed(tank: CTank): void {
    this.m_stats.tanksDestroyed++;
    const pos = tank.getPosition();

    // Standings: the victim earns a death; its killer (last damager) earns a kill for an ENEMY,
    // but LOSES one for a friendly-fire or self kill (matching the credit penalty in awardKillCredit).
    tank.addDeath();
    const killer = tank.getLastDamager();
    if (killer) {
      if (killer !== tank && killer.getTeamId() !== tank.getTeamId()) killer.addKill();
      else killer.loseKill(); // teammate or self → kill-count penalty
    }

    this.awardKillCredit(tank);

    // The dying tank cries out a random death line (Chatter, 30% chance).
    this.tryTaunt('death', tank, TAUNT_CHANCE_DEATH);

    // Create explosion at tank position
    this.m_particles.tankDeath(pos.x, pos.y + 12);
    this.m_screenShake.trigger(15, 0.5);
    this.m_audio?.tankExplode(pos.x); // tank explode.wav

    // Posthumous DEATH-weapon cook-off: a tank destroyed while still OWNING a Death-class weapon
    // detonates it on the corpse (Burial Mound heaps a big earth mound; Cremation/Ashes/Toxic Grave
    // leave their own coloured fire/radiation blast). Faithful to the original's death loop.
    this.detonateDeathWeapon(tank);
  }

  /** The dead tank cooks off the FIRST Death-class weapon it still owns, detonating it right on the
   *  corpse (the original forces power 0 / angle 90 so it drops straight down — here we detonate in
   *  place, same result). Sentries carry no arsenal, so they're skipped. Deterministic: the pick
   *  keys off the mirrored economy and the terrain deposit is seeded, so net clients stay in lockstep.
   *  A resulting blast can kill a neighbour → its own cook-off, a bounded chain (each weapon is
   *  consumed, so a tank detonates at most once). */
  private detonateDeathWeapon(tank: CTank): void {
    if (tank.isSentry()) return;
    const econ = this.economyFor(tank);
    const idx = deathWeaponIndices().find(i => econ.hasStock(i));
    if (idx === undefined) return;
    const weapon = getWeapon(idx);
    econ.consume(idx); // fired → consumed, so it can't detonate twice
    const pos = tank.getPosition();
    const surf = this.m_land.getHeightAt(Math.floor(pos.x));
    const drop = new CShot();
    drop.initFromVelocity(
      new Vec2(pos.x, surf),
      0,
      0,
      weapon.getDamage(),
      weapon.getRadius(),
      tank,
    );
    drop.setWeaponIndex(idx);
    // Same base-power seed as the live-fire Death path: a cooked-off drilling Death weapon (Six Under,
    // Toxic Grave) drills at 0.5× the CORPSE's power, not the CShot default (which would fix it at a
    // flat 0.5×50 = 25). Without this the posthumous drill mis-scales exactly as the live path did.
    drop.setBasePower(tank.getPower());
    weaponDetonate(drop, weapon, this); // full effect at the corpse: blast + earth deposit + FX
  }

  /** Kill bounty (Deathmatch only): the killer (the victim's last damager) earns
   *  +CreditKill for an enemy kill, or pays −CreditKill for a team/self kill. An
   *  unattributed death (no last damager) pays nothing. Pooled across the killer's
   *  team afterwards. */
  private awardKillCredit(victim: CTank): void {
    if (this.m_gameType !== EGameType.Deathmatch) return;
    const killer = victim.getLastDamager();
    if (!killer) return;
    const enemy = killer.getTeamId() !== victim.getTeamId();
    killer.addCredits(enemy ? this.m_creditKill : -this.m_creditKill);
    this.poolTeamCredits(killer);
  }

  /** Pool credits within a team: after an award, copy the awarded tank's balance to
   *  every same-team tank (credits are shared per team). */
  private poolTeamCredits(tank: CTank): void {
    const credits = tank.getCredits(),
      team = tank.getTeamId();
    for (const t of this.m_tanks) {
      if (t !== tank && t.getTeamId() === team) t.setCredits(credits);
    }
  }

  /** Re-sync every same-team tank to the ACTIVE economy's balance after a buy/sell/autobuy. The
   *  depot debits ONE economy (a human squad shares the depot bound to its lead tank; a bot has its
   *  own), but squad-mates hold display COPIES of the balance. Without this re-sync a squad-mate's
   *  later earn would pool its STALE, undebited balance back over the banker — refunding the purchase
   *  (the credits-vs-inventory pooling bug). Solo (one tank per team) is a self-sync no-op. */
  private poolActiveCredits(): void {
    const bal = this.activeEconomy().getCredits();
    const team = this.getCurrentTank().getTeamId();
    for (const t of this.m_tanks) if (t.getTeamId() === team) t.setCredits(bal);
  }

  /** Group the roster into teams (by team id / colour), keeping only tanks that pass
   *  `include`. The get-or-create-array idiom, in one place. */
  private groupTanksByTeam(include: (t: CTank) => boolean): Map<number, CTank[]> {
    const teams = new Map<number, CTank[]>();
    for (const t of this.m_tanks) {
      if (!include(t)) continue;
      const arr = teams.get(t.getTeamId());
      if (arr) arr.push(t);
      else teams.set(t.getTeamId(), [t]);
    }
    return teams;
  }

  /** Throw `tank` up and away from a blast/beam centred at `fromX`: the lateral sign
   *  points away from the source; magnitude scales with the LIFE actually removed (post
   *  shield/armor, clamped over the full 0..1000 range) × the Kickback setting. */
  private kickTank(tank: CTank, fromX: number, removed: number, radiusPx: number): void {
    // Explosion-size dependence: scale the impulse by the blast radius (the port's proxy for
    // the original's per-explosion kick size) so bigger blasts shove harder for equal damage.
    const sizeFactor = clamp(radiusPx / KICK_REF_RADIUS, KICK_SIZE_MIN, KICK_SIZE_MAX);
    // Per-shot RANDOM horizontal lean (the original draws a fresh lateral each blast rather
    // than a fixed lean); sign points away from the blast centre, magnitude varies the launch.
    const away = tank.getPosition().x - fromX >= 0 ? 1 : -1;
    const dir = new Vec2(away * (0.25 + this.m_rng.float() * 0.7), -1).normalize();
    tank.kick(
      dir,
      Math.min(1, removed * 0.001) * KICK_BASE * sizeFactor * GameConfig.kickbackScale,
    );
  }

  /** Award `perTank` to every alive tank (Turn / Round). Credits are shared per team,
   *  so a team's balance rises by `perTank × (its alive members)`. No-op at rate 0. */
  private awardSurvivorCredit(perTank: number): void {
    if (perTank <= 0) return;
    const teams = this.groupTanksByTeam(t => t.isAlive());
    for (const [teamId, members] of teams) {
      const shared = members[0].getCredits() + perTank * members.length;
      // Sync EVERY same-team tank (alive AND dead) to the new shared balance — not just the alive
      // members. A dead squad tank may still back the shared depot economy (the human depot binds to
      // its lead tank), so leaving its silo stale would strand a survivor's income (ECON-2). Dead
      // tanks are only SYNCED here, never PAID (the payout is perTank × alive members).
      for (const t of this.m_tanks) if (t.getTeamId() === teamId) t.setCredits(shared);
    }
  }

  /** Credit the shooter for damage dealt to an ENEMY tank: `lifeRemoved × CreditDamage`
   *  (self/friendly earns nothing), then pool across the shooter's team. On a DAMAGING hit,
   *  records the shooter as the victim's last-damager for kill attribution. */
  private creditDamage(shooter: CTank | null, victim: CTank, lifeRemoved: number): void {
    // A hit that removed NO life (fully soaked by an all-or-nothing shield / 100% armor, or barely
    // grazing the blast edge) must leave attribution untouched: otherwise a harmless graze overwrites
    // the victim's real last-damager and steals the kill + credit when the victim later dies to that
    // earlier damage (e.g. radiation DOT). Only a hit that actually took life reassigns the "killer".
    if (lifeRemoved <= 0) return;
    victim.setLastDamager(shooter);
    if (!shooter) return;
    // Standings: every damaging hit counts toward the shooter's accuracy; friendly /
    // self damage subtracts from Damage/hit (so it can go negative, as in the original).
    const friendly = shooter === victim || shooter.getTeamId() === victim.getTeamId();
    shooter.addHit(friendly ? -lifeRemoved : lifeRemoved);
    if (friendly) {
      // Ledger it (self-damage excepted — blowing yourself up is clumsy, not treachery). Squadmates
      // read this and stop extending the benefit of the doubt; see the planner's `hostility`.
      if (shooter !== victim)
        this.m_friendlyDamage.set(shooter, (this.m_friendlyDamage.get(shooter) ?? 0) + lifeRemoved);
      return;
    }
    shooter.addCredits(lifeRemoved * this.m_creditDamage);
    this.poolTeamCredits(shooter);
  }

  /** Randomize Turns (Gameplay): reorder the turn queue with 2N random transpositions —
   *  the original's repeated random pair-swaps (not a clean shuffle). The queue IS the
   *  m_tanks array; positions/teams/economy bind by reference, so only the sequence changes. */
  private shuffleTurnOrder(): void {
    const n = this.m_tanks.length;
    for (let k = 0; k < n * 2; k++) {
      const i = Math.floor(Math.random() * n);
      const j = Math.floor(Math.random() * n);
      const tmp = this.m_tanks[i];
      this.m_tanks[i] = this.m_tanks[j];
      this.m_tanks[j] = tmp;
    }
  }

  /** Whether the human may open the depot right now (Economy → Buy Time). Automatic mode
   *  disables the manual depot entirely (weapons are auto-assigned); otherwise it's gated by
   *  the acting human tank's per-turn/round Buy-Time flag. */
  canOpenDepot(): boolean {
    if (GameConfig.buyTime === 3) return false; // Automatic → no manual depot
    // Net: only on YOUR turn (the bound economy is the local player's). getCurrentTank() is
    // the local tank when it's the local turn, so the checks below then apply to your own tank.
    if (this.m_netMode && !this.isLocalNetTurn()) return false;
    const tank = this.getCurrentTank();
    return tank.isHuman() && tank.canBuy();
  }

  /** Returns whether the turn order WRAPPED (crossed the last player back to the
   *  start) — i.e. a full round just completed. */
  private advanceToNextPlayer(): boolean {
    const nPlayers = this.m_tanks.length;

    // Weapon-test mode (?weapontest=1): never hand the turn to the AI — keep it on
    // the (living) human so weapons can be fired back-to-back indefinitely.
    if (this.m_weaponTest) {
      const human = this.m_tanks.findIndex(t => t.isHuman() && t.isAlive());
      if (human >= 0) {
        this.m_currentPlayerIndex = human;
        return false;
      }
    }

    // Walk the turn ORDER by position (contiguous by default; Alternate Turns interleaves teams),
    // skipping dead tanks. A round completes when the position crosses the end of the order.
    let wrapped = false,
      attempts = 0;
    let pos = this.turnPosOf(this.m_currentPlayerIndex);
    do {
      if (pos + 1 >= nPlayers) wrapped = true; // crossed the end → round complete
      pos = (pos + 1) % nPlayers;
      this.m_currentPlayerIndex = this.turnTankAt(pos);
      attempts++;
      if (attempts > nPlayers * 2) {
        console.warn('All players dead or stuck');
        break;
      }
    } while (!this.m_tanks[this.m_currentPlayerIndex]?.isAlive());
    return wrapped;
  }

  /** The tank indices in TURN ORDER (position → tank index). Contiguous by default (`[0,1,2,3]`);
   *  interleaved under Alternate Turns (`[0,2,1,3]` = A1,B1,A2,B2). */
  getTurnOrder(): number[] {
    return this.m_tanks.map((_, pos) => this.turnTankAt(pos));
  }

  /** Number of SQUAD (non-sentry) tanks — the size of the alternate-turns interleave grid. Squad
   *  tanks occupy a contiguous prefix `[0, grid)` (created at battle start); a deployed Sentry is
   *  APPENDED past them, so it must be kept OUT of the interleave (which assumes a clean
   *  players × squad-size grid) — otherwise the map stops being a bijection and a squad tank fires
   *  twice while the sentry never gets a turn. Sentries take identity positions at the tail instead. */
  private squadGridSize(): number {
    let n = 0;
    for (const t of this.m_tanks) if (!t.isSentry()) n++;
    return n;
  }

  /** The tank index whose turn it is at turn-order POSITION `pos`. Default = identity (contiguous
   *  squads: A1,A2,B1,B2). Alternate Turns interleaves by player-slot so squads take turns one
   *  tank at a time (A1,B1,A2,B2). Deployed sentries (index ≥ the squad grid) take identity positions
   *  at the tail so they don't corrupt the interleave. */
  private turnTankAt(pos: number): number {
    if (!GameConfig.alternateTurns) return pos;
    const per = Math.max(1, this.m_tanksPerTeam);
    const players = Math.max(1, Math.floor(this.squadGridSize() / per));
    if (pos >= players * per) return pos; // appended sentries — identity at the tail
    return (pos % players) * per + Math.floor(pos / players);
  }

  /** Inverse of turnTankAt: the turn-order position of a tank index. */
  private turnPosOf(tankIdx: number): number {
    if (!GameConfig.alternateTurns) return tankIdx;
    const per = Math.max(1, this.m_tanksPerTeam);
    const players = Math.max(1, Math.floor(this.squadGridSize() / per));
    if (tankIdx >= players * per) return tankIdx; // sentries — identity at the tail
    return (tankIdx % per) * players + Math.floor(tankIdx / per);
  }

  /** Start the current player's turn. The HUD (Preact) reads state via getters. */
  private beginTurn(): void {
    this.m_movePlacing = false; // a fresh turn is never mid-placement
    this.m_moveResolving = false; // fresh turn: no committed move drive in flight
    this.m_turnForfeited = false; // fresh turn: the passive-death forfeit latch is re-armed
    // Disown any aim drag held from the PREVIOUS turn. A shot-clock forfeit ends the turn with no user
    // action, so a pointer still held would otherwise keep aiming the NEW current tank: the world drag
    // bails once m_aim.active is false, and the HUD power/angle drags bail when m_turnSeq changes.
    this.m_aim.active = false;
    this.m_turnSeq++;
    const tank = this.getCurrentTank();
    // Buy Time → Automatic: the human's arsenal is auto-assigned (no manual depot). Top it up
    // on the human's turn-begin from whatever credits are on hand (a no-op when broke). In net,
    // only the LOCAL player runs it here (autoBuyWeapons relays {t:'autobuy'} + is deterministic,
    // so peers mirror it via the command); a spectator applies the relayed autobuy instead.
    if (GameConfig.buyTime === 3 && tank.isHuman() && (!this.m_netMode || this.isLocalNetTurn())) {
      this.autoBuyWeapons();
    }
    // Restore THIS player's own weapon so the previous player's (or a bot's) choice never carries
    // over. With Weapon Persistence on the selection is squad-wide (setSquadWeapon), so a squad's
    // second tank opens on the weapon its first one was left on — the player picks for the team.
    this.m_currentWeaponIndex = tank.getWeaponIndex();
    // If the human emptied that weapon last turn (fired its last round), fall back to
    // the unlimited staple so the turn never opens on a weapon that's out of stock.
    // (Under free-fire every weapon is in stock, so this never trips.)
    if (tank.isHuman()) this.ensureStocked(tank);
    // Likewise restore THIS player's own aim + power (per-tank), so the previous
    // player's shot settings never carry over into this turn.
    this.m_angle = tank.getAimAngle();
    this.m_power = tank.getPower();
    if (tank.isHuman()) tank.setTurretAngle(this.m_angle);
    this.m_gameState = EGameState.Battle;
    this.m_turnStartAngle = this.m_angle;
    this.m_turnStartPower = this.m_power;

    // New turn: drop any minimap-scroll override so the camera eases to centre the
    // player whose turn it now is, and clear the shot the camera was tracking.
    this.m_manualScroll = false;
    this.m_activeShot = null;
    // Focus the player whose turn it is — Graphics → Camera picks the feel of the hand-off:
    //  • INSTANT   — if the active tank is OFF-SCREEN, snap onto it (the player must SEE whose turn it
    //                is even across several screens before a bot fires ~0.6s later). On-screen eases.
    //  • SMOOTH    — never snap; updateCamera eases across to the new tank (no jarring jump).
    //  • CINEMATIC — hold on the impact for a beat (updateCamera counts m_camDwell down), then ease.
    const focusX = tank.getPosition().x;
    const offScreen = focusX < this.m_camX || focusX > this.m_camX + this.m_viewW;
    if (GameConfig.cameraMode === CAM_INSTANT && offScreen) {
      this.centerCameraOn(focusX);
    } else if (GameConfig.cameraMode === CAM_CINEMATIC && offScreen && this.m_impactThisTurn) {
      // Only linger if a blast actually landed on the turn that just ended — a shotless hand-off
      // (a shot-clock forfeit, a move-only turn) has no impact to dwell on, so we'd otherwise pan the
      // wrong way toward a stale/zero m_lastImpactX. Without an impact, fall through to the Smooth ease.
      this.m_camDwell = CAM_DWELL_SEC;
    }
    this.m_impactThisTurn = false; // re-arm for the new turn (set true again when this turn's shot lands)

    // Re-arm the taunt state for the new turn: no shot yet (gates the post-fire gloat)
    // and a fresh idle-taunt countdown.
    this.m_firedThisTurn = false;
    this.m_tauntTimer = TAUNT_IDLE_MIN + Math.random() * (TAUNT_IDLE_MAX - TAUNT_IDLE_MIN);

    // Arm the shot-time countdown for a human turn (bots fire on a schedule and
    // never time out). Reset the clock either way so it never leaks across turns.
    // Arm a FRESH shot clock for the new turn. It runs only for the player actually in control —
    // in a network match solely the local player on their own turn (spectators never forfeit).
    this.armShotClock(true);

    // A deployed Sentry takes its own turn: aim at the nearest enemy and fire in a direct
    // line. It never moves and never uses a normal bot solve, so route it separately.
    if (tank.isSentry()) {
      this.schedule(0.6, () => this.executeSentryTurn());
    }
    // Demo Mode (More Graphics Options): the human's turns are played by the AI too, so the
    // game plays itself.
    else if (tank.isBot() || (GameConfig.demo && tank.isHuman())) {
      this.schedule(0.7, () => this.executeBotTurn());
    }
    this.markDirty(); // new turn: indicator moves, aim resets → redraw
  }

  /** Generate the battle terrain: a DEV flat test surface (`?flatland=1`), a forced
   *  landscape shape (Settings → Land Type), or the usual random landscape. */
  private generateTerrain(): void {
    // Fresh terrain → wipe last battle's lingering effects so smoke/fumes/debris don't carry over
    // onto the new map (the particle system persists across battles; the CLand regen clears its own
    // transient debris/fallout/heat below).
    this.m_particles.clear();
    // A shared seed (network match) makes every client generate byte-identical
    // terrain; Date.now() keeps solo play freshly random.
    const seed = this.m_terrainSeed ?? Date.now();
    if (this.m_flatLand) this.m_land.generateFlat();
    else if (this.m_landMode >= 0 && this.m_landMode <= 4)
      this.m_land.generateTerrainMode(this.m_landMode, seed);
    else this.m_land.generateRandomTerrain(seed);
  }

  /** Spawn X for tank `i` of `n`: spread across the world with a little jitter. */
  /** Randomize Position (Gameplay): which spawn SLOT each tank takes, as a permutation of 0..n-1.
   *  Off, tank i takes slot i — tanks are pushed squad by squad, so a player's squad lands as one
   *  contiguous block on the map. On, the slots are shuffled, so squads end up interleaved and no
   *  player owns a stretch of ground. Only the index→slot mapping changes: the m_tanks array (the
   *  turn queue, the snapshot indices, the alternate-turns squad grid) is untouched, so this is
   *  purely about where tanks stand. Drawn from the SEEDED match RNG, so a network match lands on
   *  the same layout on every client (unlike shuffleTurnOrder, which uses Math.random and is
   *  forced off in net play). */
  private spawnSlots(n: number): number[] {
    const slots = Array.from({length: n}, (_, i) => i);
    if (!GameConfig.randomizePosition) return slots;
    for (let i = n - 1; i > 0; i--) {
      const j = this.m_rng.int(i + 1);
      const tmp = slots[i];
      slots[i] = slots[j];
      slots[j] = tmp;
    }
    return slots;
  }

  /** Give `tank` its opening shot settings: a random angle over the upward half-circle and a random
   *  power, so a battle doesn't start with every barrel frozen at the same 45° / 500. Both ranges
   *  come from the original (see the START_AIM / START_POWER bounds). Drawn from the SEEDED
   *  match RNG, so a network match opens identically on every client. The turret sprite and the
   *  last-shot fields follow the draw — the panel's Reset button is documented to return to the
   *  starting aim before the first shot, so it must not snap back to a 45°/500 never held. */
  private randomizeStartAim(tank: CTank): void {
    const deg = this.m_rng.rangeInt(START_AIM_MIN, START_AIM_MAX);
    const power = this.m_rng.rangeInt(START_POWER_MIN, START_POWER_MAX);
    tank.setAimAngle(deg);
    tank.setTurretAngle(deg);
    tank.setPower(power);
    tank.saveLastShot(deg, power);
  }

  private tankSpawnX(i: number, n: number): number {
    const worldW = this.m_worldWidth;
    const margin = Math.min(120, 0.025 * this.m_worldWidth);
    const frac = n <= 1 ? 0.5 : i / (n - 1);
    return Math.max(
      60,
      Math.min(worldW - 60, margin + frac * (worldW - 2 * margin) + this.m_rng.plusMinus(20)),
    );
  }

  /** Start the next battle of a war: fresh LANDSCAPE (climate + terrain), tanks respawned
   *  (cumulative war stats + credits kept), turn order reset. No-op once the war is over (the
   *  caller exits to the menu instead). */
  nextBattle(): void {
    if (this.getWarOver()) return;
    this.m_currentBattle++;
    this.m_currentRound = 1; // the round counter resets each battle (round-1 forced-aim keys off it)
    this.m_shots = [];
    this.m_pendingSalvos = 0; // no salvos carry across a battle boundary (defensive; matches setupBattle)
    this.m_netShotResolving = false; // nor a stale resolving flag (defensive; matches setupBattle)
    // Drop any closure still queued from the finished battle (e.g. an explode-losers cascade the player
    // clicked past before it finished): m_time is monotonic and nextBattle RESPAWNS the tanks those
    // closures captured, so a survivor would otherwise be blown up by a stale corpse's timer. finishBattle
    // already clears these today, so this is defensive — and mirrors setupBattle's own m_timers reset.
    this.m_timers = [];
    this.m_mines = [];
    this.m_aimMarkers = [];
    this.m_damageNumbers = [];
    this.m_blastCircles = [];
    this.m_crates = [];
    this.m_floatTexts = [];
    this.m_bubbles = [];
    this.m_fireworks = [];
    this.m_rockets = [];
    this.m_showFireworks = false;
    this.generateTerrain();
    // A new battle is a new PLACE, not just a new heightmap: roll a fresh landscape (sky, strata
    // textures, weather, ambient tint) exactly as the original's level builder does per battle.
    // Kept in m_loadPromise so the caller can hold the standings/loading screen up until the new
    // climate is decoded (see assetsReady + advanceWar) rather than popping it in mid-battle.
    // NET: pickLandscapeIndex draws from the seeded RNG here, and netNextBattle reseeds it from the
    // server's per-battle seed right before this call — so every client rolls the same landscape.
    this.m_loadPromise = this.loadLandscape();
    // Sentries are per-battle: clear last battle's deployed turrets before respawning.
    this.m_tanks = this.m_tanks.filter(t => !t.isSentry());
    const n = this.m_tanks.length;
    const slots = this.spawnSlots(n); // a FRESH scatter each battle (identity when the option is off)
    this.m_tanks.forEach((t, i) => {
      t.respawn(this.tankSpawnX(slots[i], n), this.m_land);
      this.randomizeStartAim(t); // a fresh opening aim each battle, like the fresh terrain/positions
      t.setWeaponIndex(this.m_currentWeaponIndex);
      t.setCanBuy(true); // Buy Time: depot re-opens at each battle's start
    });
    // Randomize Turns: re-shuffle the turn queue for the new battle (never in net — the
    // server arbitrates order; local Math.random() shuffle would desync).
    if (GameConfig.randomizeTurns && !this.m_netMode) this.shuffleTurnOrder();
    this.m_currentPlayerIndex = 0;
    this.m_winnerName = '';
    this.m_gameState = EGameState.Battle;
    // Fresh camera state for the new battle BEFORE beginTurn — else the previous battle's winning-blast
    // impact/flag would survive into a regenerated map and make Cinematic mode arm a dwell on a stale
    // coordinate (a wrong-way drift). Mirrors startGame's reset order. (Client-local; no net effect.)
    this.m_impactThisTurn = false;
    this.m_lastImpactX = 0;
    this.m_camDwell = 0;
    this.beginTurn();
    // A new battle OPENS framed on the first player — like startGame, and regardless of the Camera
    // mode (which governs mid-battle turn hand-offs). Without this snap the default Smooth mode would
    // pan in across the fresh map from wherever BattleEnd left the camera (the winner) — slow on big maps.
    this.m_manualScroll = false;
    this.centerCameraOn(this.getCurrentTank().getPosition().x);
    // Start a fresh battle track. This also cuts the previous battle's win/lose
    // jingle (battleWon/battleLost, played once): starting a new looping bed
    // replaces whatever the music player was last asked to play, so the victory
    // music doesn't linger into the next battle.
    this.m_audio?.battleMusic();
  }

  /** Drop all taunt bubbles (leaving the standings → next battle or the menu). */
  clearTaunts(): void {
    this.m_bubbles = [];
    this.m_fireworks = [];
    this.m_rockets = [];
    this.m_showFireworks = false;
  }

  /** True once the war's final battle has been played (Deathmatch multi-battle);
   *  Rounds/Points is a single battle, so it is "over" as soon as it ends. */
  private getWarOver(): boolean {
    return this.m_gameType === EGameType.Deathmatch
      ? this.m_currentBattle >= this.m_totalBattles
      : true;
  }

  /** End the current turn: declare a winner, or hand off to the next player. The
   *  end-of-game trigger is mode-aware:
   *   • Deathmatch ends the instant ≤ 1 TEAM survives (the killing shot ends the battle) —
   *     a squad ends it when every enemy team is wiped, not only on the last tank.
   *   • Rounds/Points never ends early on eliminations; it plays the full round count and
   *     scores by points. A total wipeout (no team left) still ends any mode. */
  private endTurn(): void {
    // The battle is already over — a stale scheduled closure (a settled Move poll, a bot/sentry with
    // no target) must not re-enter finishBattle and restart the winner animation / replay the jingle.
    if (this.m_gameState === EGameState.BattleEnd) return;
    this.m_turnTimerRunning = false; // the clock never outlives its turn
    this.m_charging = false; // and neither does a fire wind-up (defensive; a committed shot already cleared it)

    // Network match: the server arbitrates turns. The local simulation has settled — clear the
    // resolving flag, report the outcome, and wait for turnBegin. (endTurn can fire repeatedly
    // here once a team is eliminated — endBattleIfDecided re-checks every frame — so the
    // deterministic turn-hand-off effects (crate roll, income) are driven ONCE by the server's
    // hand-off turnBegin instead; see netTurnHandoff / netAwardRoundCredit.)
    if (this.m_netMode) {
      this.m_netShotResolving = false;
      this.m_onNetTurnEnd?.();
      return;
    }

    const rounds = this.m_gameType === EGameType.Rounds;
    const teamsLeft = this.livingTeamCount();

    if (teamsLeft === 0 || (!rounds && teamsLeft <= 1)) {
      this.finishBattle();
      return;
    }

    const actor = this.getCurrentTank(); // the tank whose turn just ended

    // Post-fire gloat: as the turn passes on after a shot, the tank that just fired
    // may taunt a random post-fire line (Chatter, 8% chance, on the turn hand-off).
    // Only after an actual shot, never a timed-out forfeit.
    if (this.m_firedThisTurn) this.tryTaunt('postFire', actor, TAUNT_CHANCE_POSTFIRE);

    // Hand off, then pay the between-turn credits. A completed round (turn order
    // wrapped) pays Credit Round to every survivor first, then Credit Turn every
    // hand-off. Credits are pooled per team inside the award.
    const wrapped = this.advanceToNextPlayer();
    if (wrapped) {
      this.m_currentRound++;
      this.awardSurvivorCredit(this.m_creditRound);
      // Roll the Crates chance ONCE per ROUND (the setting is "chance each round"). It used to roll
      // on every turn hand-off, so an N-player round got N rolls → multiple crates per round.
      this.maybeSpawnCrate();
    }
    this.awardSurvivorCredit(this.m_creditTurn);

    // Buy Time (Economy): after acting, a player loses depot access — UNLESS Anytime(0) or
    // Automatic(3). A new round re-opens the depot for everyone only in After-round(1) mode.
    if (GameConfig.buyTime === 1 || GameConfig.buyTime === 2) actor.setCanBuy(false);
    if (wrapped && GameConfig.buyTime === 1) for (const t of this.m_tanks) t.setCanBuy(true);

    // Change Wind (Gameplay): discrete reroll on the chosen cadence — every shot (2), or at
    // each round boundary (1). Per-game (0) holds; Anytime (3) drifts each frame instead.
    if (GameConfig.changeWind === 2) this.updateWind();
    else if (wrapped && GameConfig.changeWind === 1) this.updateWind();

    // Rounds/Points: the game ends once the configured number of rounds has been played
    // (the counter runs 1..N; passing N ends it), regardless of how many tanks are dead.
    if (rounds && this.m_currentRound > this.m_totalRounds) {
      this.finishBattle();
      return;
    }
    this.beginTurn();
  }

  /** Hand off to the BattleEnd state and declare the winner (mode-aware). */
  private finishBattle(): void {
    this.m_gameState = EGameState.BattleEnd;
    // Cancel every pending turn-scoped timer (a queued bot/sentry fire, a waitForRest move poll, an
    // endTurn). A battle can end mid-delay when the last enemy dies PASSIVELY (radiation DOT, a mine)
    // during a bot's pre-fire delay; without this the stale fire() would launch a live shot onto the
    // finished battle (clearing the standings), and stale endTurn/poll closures would re-enter here.
    // Any timer finishBattle itself needs (explodeLosingTeams below) is scheduled AFTER this clear.
    this.m_timers = [];
    this.m_battleEndTime = 0; // restart the winner-flag animation
    // Victory-only sky fireworks (war end, the human's team leads the final standings).
    this.m_showFireworks = this.isHumanWarVictory();
    this.m_fireworks = [];
    this.m_rockets = [];
    this.m_fireworkTimer = 0.35; // first burst shortly after the screen appears
    if (this.m_showFireworks) loadBurstPixels(); // warm the burst bmps

    // The winner is the LEADING team — Deathmatch: most kills; Rounds/Points: most points
    // (Σ net damage), which may be an entirely dead team. Its representative names the
    // winner banner, plants the flag, and gloats a post-fire line through the taunt-bubble
    // system (the bubble persists on the standings screen — bubbles only age in Battle).
    // A Rounds tie across all teams → no winner (a Draw), so no banner name.
    const leader = this.getLeadingTeam();
    this.m_winnerName = leader ? leader.members[0].getName() : '';

    // Explode Losers (Graphics): once the result is decided, detonate every still-standing tank
    // that is NOT on the winning team — the original's end-of-round wipeout cinematic. Purely
    // cosmetic (no scoring), and the main reason to have it in Rounds, where losers are otherwise
    // never destroyed. Skipped on a Draw (no leader) since there are no "losers".
    this.explodeLosingTeams(leader);
    const speaker = leader?.rep ?? null;
    const victorLine = pickTaunt('postFire');
    if (speaker && victorLine && GameConfig.chatter && !speaker.isSentry()) {
      this.m_bubbles = this.m_bubbles.filter(b => b.speaker !== speaker);
      this.m_bubbles.push({
        id: ++this.m_bubbleSeq,
        speaker,
        text: fmt(strings.value.game.bubble, {name: speaker.getName(), line: victorLine}),
        age: 0,
      });
    }
    this.m_audio?.stopTankMove();
    // Win/lose jingle — victory if the leading team is the human's.
    const humanWon = leader?.human ?? false;
    if (humanWon) this.m_audio?.battleWon();
    else this.m_audio?.battleLost();
    // Record this battle's outcome for the local human's Battle Heroes tally — only in
    // matches a human is actually playing (skip all-AI demo games). The UI consumes it
    // once (takeBattleOutcome) to advance the persisted won/lost counters.
    if (this.m_tanks.some(t => t.isHuman())) {
      this.m_pendingBattleOutcome = humanWon ? 'won' : 'lost';
    }
    // Bank the battle (and the war, if this was its last) in the global counters RIGHT HERE — the
    // moment the standings appear. Nothing about the upload waits on the player clicking past them.
    this.m_onStats?.({battles: 1, warOver: this.getWarOver()});
  }

  /** Explode Losers (Graphics): blow up every still-standing tank not on the winning team as the
   *  battle ends — the original's end-of-round wipeout. Cosmetic only (no kills/credit): it forces
   *  the wreck state + spawns one explosion per tank, staggered so it reads as a cascade rather
   *  than a single flash. NOTE this is a LOCAL gfx toggle (not in MatchConfig), and t.explode()
   *  writes hashed state (life/alive) — so two net clients with the setting set differently WOULD
   *  diverge. It's safe only because the cascade runs at terminal BattleEnd (Rounds is a single
   *  battle; net Deathmatch schedules nothing here since losers are already dead), after which no
   *  lockstep stateHash is ever compared. Don't hash state after finishBattle without revisiting. */
  private explodeLosingTeams(leader: {members: CTank[]} | null): void {
    if (!GameConfig.explodeLosers || !leader) return;
    const winTeam = leader.members[0].getTeamId();
    let n = 0;
    for (const t of this.m_tanks) {
      if (t.isSentry() || t.getTeamId() === winTeam || !t.isAlive()) continue;
      const delay = n++ * 0.18; // cascade the blasts
      this.schedule(delay, () => {
        const pos = t.getPosition();
        t.explode();
        this.m_particles.tankDeath(pos.x, pos.y + 12);
        this.m_screenShake.trigger(15, 0.5);
        this.m_audio?.tankExplode(pos.x);
      });
    }
  }

  /** The team currently leading the standings, its representative tank, and whether it's
   *  the human's — mode-aware. Deathmatch: most kills (tie → team average life%).
   *  Rounds/Points: most points (Σ net damage dealt); an exact tie across ALL teams → null
   *  (a Draw). Also null when no player teams remain. The representative is the team's own
   *  top scorer — used for the winner flag/gloat. (Rounds is non-lethal, so its rep is always
   *  a living tank; a Deathmatch rep can be dead if its whole team was wiped.) */
  private getLeadingTeam(): {members: CTank[]; rep: CTank; human: boolean} | null {
    const teams = [...this.groupTanksByTeam(t => !t.isSentry()).values()];
    if (teams.length === 0) return null;
    const rounds = this.m_gameType === EGameType.Rounds;
    const score = (t: CTank) => (rounds ? t.getDamageDealt() : t.getKills());
    const agg = teams.map(members => {
      let s = 0,
        life = 0;
      for (const m of members) {
        s += score(m);
        life += clamp01(m.getHealth().nLife / m.getMaxLife());
      }
      return {members, score: s, life: life / members.length};
    });
    // Rounds: an exact tie across every team is a Draw (no winner).
    if (rounds && agg.length > 1 && agg.every(a => a.score === agg[0].score)) return null;
    agg.sort((a, b) => b.score - a.score || b.life - a.life);
    const top = agg[0];
    const rep = top.members.reduce((a, b) => (score(b) > score(a) ? b : a));
    return {members: top.members, rep, human: top.members.some(m => m.isHuman())};
  }

  /**
   * (Re)arm the shot clock for the tank currently in control. `fresh` starts a new countdown (a new
   * turn); otherwise it RESUMES from where it paused — control handed back to the human after a jet
   * flight or a free utility. Those pause the clock rather than refunding it, so a turn still can't be
   * stalled forever by jetting / spamming free utilities. The clock only runs for a human actually in
   * control (not bots, not weapon-test), and in a net match only the local player on their own turn —
   * a forfeit is driven solely by the acting client, so this never touches the deterministic sim.
   */
  private armShotClock(fresh: boolean): void {
    const tank = this.getCurrentTank();
    if (fresh) this.m_turnElapsed = 0;
    this.m_turnTimerRunning =
      GameConfig.roundTime > 0 &&
      tank.isHuman() &&
      !this.m_weaponTest &&
      (!this.m_netMode || this.isLocalNetTurn());
  }

  /**
   * Advance the shot-time countdown during a human's turn. When the clock runs
   * out the turn is forfeited (no shot) — the panel bar has already gone red.
   * Only ticks while `m_turnTimerRunning`, so it's inert for bots, after firing,
   * and while a shot/explosion is resolving (those aren't the Battle state).
   */
  private updateTurnTimer(dt: number): void {
    if (!this.m_turnTimerRunning) return;
    this.m_turnElapsed += dt;
    if (this.m_turnElapsed >= GameConfig.roundTime) {
      this.m_turnTimerRunning = false;
      this.endTurn(); // time's up → forfeit the turn (a stale open depot auto-closes on hand-off)
    }
  }

  /** Whether the human currently has live control and is waiting to fire — the phase during which
   *  the FIRE bar (charge, countdown, or inert track) is meaningful. False for bots / shots in
   *  flight / weapon test / a remote client's turn. */
  private isHumanControlPhase(): boolean {
    return (
      this.m_gameState === EGameState.Battle &&
      !this.m_weaponTest &&
      this.getCurrentTank().isHuman() &&
      (!this.m_netMode || this.isLocalNetTurn())
    );
  }

  /** Advance the fire wind-up; launches the shot once the bar has filled and flashed green. */
  private updateFireCharge(dt: number): void {
    if (!this.m_charging) return;
    this.m_chargeElapsed += dt;
    this.markDirty();
    if (
      this.m_chargeElapsed >=
      CGameController.FIRE_CHARGE_TIME + CGameController.FIRE_GREEN_HOLD
    ) {
      this.m_charging = false;
      this.fire(); // wind-up done → launch for real (fire() clears m_charging too, defensively)
    }
  }

  /**
   * Shot entry for a LOCAL actor (human input, or a bot's scheduled fire). A real projectile first
   * WINDS UP the FIRE bar (charges red→full→green) before it launches; updateFireCharge calls fire()
   * when the bar fills. On-use actions (utilities / move / jet), weapon test, and net turns that
   * aren't ours skip the wind-up and fire at once. Net peers and the post-charge completion call
   * fire() directly, never this. Bots only wind up in single-player (in net the host relays 'fire',
   * and a delayed launch there would just add lag for spectators).
   */
  requestFire(): void {
    if (this.m_charging) return; // already winding up — ignore repeat presses
    const tank = this.getCurrentTank();
    // Humans wind up on their local turn (incl. net); bots wind up only in single-player.
    const actorEligible = tank.isHuman()
      ? !this.m_netMode || this.isLocalNetTurn()
      : !this.m_netMode;
    if (
      actorEligible &&
      this.m_gameState === EGameState.Battle &&
      tank.isAlive() &&
      !tank.isMoving() &&
      !this.m_weaponTest &&
      this.isChargeableShot(getWeapon(this.m_currentWeaponIndex).getExtType())
    ) {
      this.m_charging = true;
      this.m_chargeElapsed = 0;
      this.m_turnTimerRunning = false; // committed to the shot — hold the clock during the wind-up
      this.markDirty();
      return;
    }
    this.fire(); // utilities / move / jet / net peer: no wind-up, fire immediately
  }

  /**
   * State for the panel bar below FIRE. Three modes:
   *  • charge — a human's shot is winding up: fills red 0→full, then green (the launch flash).
   *  • timer  — Round Timer on: drains green→yellow→red; `frac` is the fraction REMAINING.
   *  • off    — Round Timer disabled during the human's turn: an inert dark track (no cap).
   * Returns null when there's nothing to show (bot turn, shot in flight, weapon test).
   */
  getTurnTimer(): {frac: number; color: string; charge?: boolean; off?: boolean} | null {
    if (this.m_charging) {
      const t = CGameController.FIRE_CHARGE_TIME;
      const frac = clamp01(this.m_chargeElapsed / t);
      // Red while filling; green once full (held briefly before the projectile leaves).
      const color = this.m_chargeElapsed >= t ? '#00ff00' : '#ff0000';
      return {frac: this.m_chargeElapsed >= t ? 1 : frac, color, charge: true};
    }
    if (!this.isHumanControlPhase()) return null;
    if (GameConfig.roundTime <= 0) return {frac: 1, color: '#0a0f0a', off: true}; // untimed → dark bar
    const frac = clamp01(1 - this.m_turnElapsed / GameConfig.roundTime);
    const color = frac > 0.33 ? '#00ff00' : frac > 0.12 ? '#ffff00' : '#ff0000';
    return {frac, color};
  }

  /** A weapon whose FIRE launches a real projectile (so it gets the fire wind-up). Excludes the
   *  on-use utilities that end the turn without a shot: Move, Jet, Shield, Heal, Armor, Hazmat,
   *  and the Bunker/Wall terrain tools. (Sentry is bot-only and gated by the isHuman() check.) */
  private isChargeableShot(ext: ExtType): boolean {
    return (
      ext !== EXT.MOVE &&
      ext !== EXT.JET &&
      ext !== EXT.SHIELD &&
      ext !== EXT.HEAL &&
      ext !== EXT.ARMOR &&
      ext !== EXT.HAZMAT &&
      ext !== EXT.BUNKER_WALL
    );
  }

  /** Get current player's tank. */
  getCurrentTank(): CTank {
    return this.m_tanks[this.m_currentPlayerIndex];
  }

  // ========================================================================
  // FIRING SEQUENCE
  // ========================================================================

  /** Fire currently selected weapon from current player. */
  fire(): void {
    if (this.m_paused) return; // debug freeze rejects all input
    // The battle is over (standings showing) — a bot/sentry fire() queued before the last enemy died
    // passively must not launch a live shot onto the finished battle. Human input is already gated by
    // canAct() (Battle-only); this closes the scheduled-closure path that bypasses it.
    if (this.m_gameState === EGameState.BattleEnd) return;
    const tank = this.getCurrentTank();
    if (!tank.isAlive()) return;
    if (tank.isMoving()) return; // can't act while a move is under way

    // Move utility (human): FIRE doesn't move immediately — it ARMS click-to-place (the band
    // brightens; the next click on it drives the tank there, via placeMove). It never consumes or
    // ends the turn here. Bots drive directly (botMove); the AI-driven Demo tank keeps the old
    // aim-point move below.
    if (
      tank.isHuman() &&
      !GameConfig.demo &&
      getWeapon(this.m_currentWeaponIndex).getExtType() === EXT.MOVE
    ) {
      if (!this.m_movePlacing) {
        this.m_movePlacing = true;
        this.markDirty();
      }
      return;
    }

    this.m_turnTimerRunning = false; // committed to a shot — stop the clock
    this.m_charging = false; // a direct fire() (bot / net peer / post-charge) clears any wind-up
    this.m_manualScroll = false; // fire → camera resumes auto-follow (chases the shot)
    this.m_firedThisTurn = true; // a shot was taken → post-fire gloat is eligible at turn end

    // Network: this turn's action is now resolving — hold the next hand-off until it
    // settles (both the acting client and every simulating spectator set this).
    if (this.m_netMode) this.m_netShotResolving = true;

    // Ammo: never fire a weapon that's out of stock — if the selected one was emptied or sold
    // off, fall back to the unlimited staple. In a NET match only the ACTING client charges
    // ammo (from ITS own inventory): spectators just simulate the exact weapon the actor
    // relays below, so they must NOT gate on their (empty) copy of the actor's stock. Charging
    // is done BEFORE the relay so peers are told the FINAL weapon (post-staple-fallback).
    // A Sentry reports isBot() (it isn't human), but it does NOT draw from an inventory — it fires the
    // fixed weapon executeSentryTurn selected (Turret→Shell, Minigun→Machine Gun). Charging ammo would
    // run ensureStocked, find no Machine-Gun rounds in the sentry's empty economy, and SWAP it back to
    // the staple Shell — so the Minigun sentry fired a plain Shell. Exclude sentries from the ammo path.
    const chargeAmmo =
      !GameConfig.demo &&
      !tank.isSentry() &&
      (tank.isHuman() || tank.isBot()) &&
      (!this.m_netMode || this.isLocalNetTurn());
    if (chargeAmmo) this.ensureStocked(tank);

    // Relay this shot so every peer SIMULATES it deterministically — the weapon, the final
    // aim, then the fire. All clients compute the same outcome (seeded RNG + fixed timestep);
    // the authoritative snapshot at turn end is only a drift keyframe.
    if (this.isLocalNetTurn()) {
      this.m_onNetCommand?.({t: 'selectWeapon', index: this.m_currentWeaponIndex});
      this.m_onNetCommand?.({t: 'aim', angle: this.m_angle, power: this.m_power});
      this.m_onNetCommand?.({t: 'fire'});
    }

    const weapon = getWeapon(this.m_currentWeaponIndex);
    const ext = weapon.getExtType();

    // Play stats: one fire action (nuke-class tracked separately). shotsFired (projectile count) is
    // added at the salvo below. Every client tallies; only the uploader (host/solo) sends them.
    this.m_stats.weaponsFired++;
    if (weapon.isNuclear()) this.m_stats.nukesFired++;
    // Log what this side just threw, so their opponents can read intent (Ultra threat model).
    this.ultraNoteEnemyShot(tank, this.m_currentWeaponIndex);

    if (chargeAmmo) this.economyFor(tank).consume(this.m_currentWeaponIndex);

    // soundFire, panned to the firing tank.
    this.m_audio?.fire(weapon.getFireSound(), tank.getPosition().x);

    // Jet (extType 17): light the jet with fuel = damage (5s/15s) and enter the
    // Flying state. Flight repositions the tank but does NOT end the turn — the
    // player still fires afterwards. Bots don't fly, so for them it just consumes
    // the turn.
    if (ext === EXT.JET) {
      // A buried tank can't fly out (igniteJet refuses) → fall through to the no-flight path.
      if (tank.isHuman() && tank.igniteJet(weapon.getDamage())) {
        this.m_gameState = EGameState.Flying;
        this.m_lastJetRelay = null; // fresh flight → the first thrust change always relays
      } else {
        this.m_gameState = EGameState.Battle;
        this.schedule(0.4, () => this.endTurn());
      }
      return;
    }

    // Move utilities (extType 3 — Move Near/Mid/Far): the original shows a green move-AREA
    // (`[tankX ± budget]`, budget = worldWidth·dmg·0.01) and the tank drives to the point the
    // player picks WITHIN it. We use the aim cursor as that pick, clamped to the budget — so you
    // aim at a spot in the green band and it walks there. Consumes the turn; no shot.
    if (ext === EXT.MOVE) {
      const budget = this.moveRange(weapon);
      const tx = tank.getPosition().x;
      const pick = this.aimPoint(this.m_angle, this.m_power).x; // where the player is pointing
      const destX = clamp(pick, tx - budget, tx + budget);
      this.startTankMove(tank, destX);
      return;
    }

    // Utility items apply an effect to the firing tank instead of launching a shot.
    if (this.applyUtility(tank, weapon, ext)) {
      this.m_gameState = EGameState.Battle;
      // Utility Turn (Gameplay, default OFF): when OFF a utility is "free" — the human keeps
      // control and can still aim/fire this turn. When ON, using it ends the turn like a shot.
      // Bots (and the AI-driven Demo tank) always end their turn (one action), so the flag is
      // human-only in normal play.
      if (GameConfig.utilityTurn || tank.isBot() || GameConfig.demo) {
        this.schedule(0.4, () => this.endTurn());
      } else {
        this.m_firedThisTurn = false; // a free utility isn't a shot → no post-fire gloat gating
        // Control stays with the human → RESUME the shot clock (paused at fire, not reset), so a free
        // utility spends turn time rather than refilling it and can't be used to dodge the deadline.
        this.armShotClock(false);
        this.markDirty();
      }
      return;
    }

    this.m_shotsFired++; // a real projectile is launched (utilities don't count)
    tank.addShot(); // per-tank shot count (standings Accuracy denominator)
    // Fresh shot setup wipes the previous shot's transient marks — tracer ranging
    // pins live only until the NEXT round is launched (they aren't a growing history).
    // The tracer we may be firing right now plants its own pins later, in flight.
    this.m_aimMarkers = [];
    this.m_damageNumbers = [];
    this.m_blastCircles = [];
    // Remember this aim as the tank's "last shot" so the reset (↺) button can
    // restore power+angle to it (non-utility only).
    tank.saveLastShot(this.m_angle, this.m_power);

    // Death weapons ("Six Under", "Cremation", "Ashes", "Toxic Grave"…): a self-targeting
    // round that drops onto the FIRER. The original ignores the player's aim — it forces
    // the turret straight up and the power to 0, so the round leaves the muzzle with no
    // speed and just falls back down onto the tank that fired it (a "bury yourself"
    // shot). We spawn at the straight-up muzzle with zero velocity → a short drop onto
    // the shooter, not a bomb materialising high in the sky.
    if (ext === EXT.DEATH) {
      const drop = new CShot();
      drop.initFromVelocity(
        tank.muzzleForAngle(90),
        0,
        0,
        weapon.getDamage(),
        weapon.getRadius(),
        tank,
      );
      drop.setWeaponIndex(this.m_currentWeaponIndex);
      // A Death round drops at power 0, but its submunition DRILL (Six Under, Toxic Grave, …) launches
      // at 0.5× the FIRER's power. initFromVelocity never sets the shot's power, so its base-power
      // would fall back to the CShot default (→ a fixed 0.5×50 = 25 drill). Seed it with the firer's
      // actual power so the drill scales with the shot the player set up.
      drop.setBasePower(this.m_power);
      this.m_shots.push(drop);
      this.m_gameState = EGameState.ShotFlying;
      return;
    }

    const muzzlePos = tank.getMuzzlePosition();
    const baseAngle = tank.firingAngle(); // world barrel angle (Relative Turrets applies here)
    const isBeam = isBeamExt(ext);
    // Per-shot inaccuracy — gated by Settings → Gameplay → Variance.
    const varianceRad = this.m_variance ? deg2rad(weapon.getVariance()) : 0;

    // Multi-fire: `spawn` = SIMULTANEOUS rounds in a fan, `spread` = degrees
    // between them, `sucNum` = SUCCESSION (fires sucNum+1 times in a row). So a
    // Cannon (spawn 5) sprays 5 pellets, a Machine Gun (sucNum 11) rattles off
    // ~12, a Tomcat (spawn 3, spread 3) fans 3 rockets.
    const rounds = Math.max(1, weapon.getSpawnCount());
    this.m_stats.shotsFired += rounds; // each fanned round is a projectile (beam or ballistic)
    const spacingRad = deg2rad(weapon.getFanSpacingDeg());

    // Beams are instantaneous hitscan: resolve the whole fan this frame (no flying
    // projectile), then Explosion waits for the flash to fade. (No beam has a
    // succession count, so beams don't burst.)
    if (isBeam) {
      for (let i = 0; i < rounds; i++) {
        const fan = this.fanOffset(i, rounds, spacingRad);
        const jitter = varianceRad > 0 ? this.m_rng.plusMinus(varianceRad) : 0;
        this.fireBeam(muzzlePos, baseAngle + fan + jitter, weapon, tank);
      }
      this.m_shots = [];
      this.m_gameState = EGameState.Explosion;
      return;
    }

    // One salvo = `rounds` rounds fanned `spacingRad` apart, + per-round variance,
    // plus the muzzle blast. `sucNum+1` salvos fire in SUCCESSION `sucSec` apart —
    // a burst for machine guns / gatlings.
    const dmg = weapon.getDamage(),
      rad = weapon.getRadius();
    const flash = weapon.getMuzzleFlash(),
      muSmoke = weapon.getMuzzleSmoke();
    // `withFx`: replay the report + muzzle flash for this salvo. The original gates the
    // repeat FX/SFX on `sucSec > 0.5` — slow successions (machine gun, hellfire, rail)
    // bark once per salvo; fast bursts (cannon/shotgun, sucSec 0.1) are near-instant and
    // fire silently after the opener, so we skip their repeat flash+sound too.
    const fireSalvo = (withFx: boolean) => {
      for (let i = 0; i < rounds; i++) {
        const fan = this.fanOffset(i, rounds, spacingRad);
        const jitter = varianceRad > 0 ? this.m_rng.plusMinus(varianceRad) : 0;
        const pShot = new CShot();
        pShot.initFromTank(muzzlePos, baseAngle + fan + jitter, this.m_power, dmg, rad, tank);
        pShot.setWeaponIndex(this.m_currentWeaponIndex);
        this.m_shots.push(pShot);
      }
      if (withFx && (flash > 0 || muSmoke > 0)) {
        const d = {x: Math.cos(baseAngle), y: -Math.sin(baseAngle)};
        const col = weapon.getColor();
        // FLASH first — the bright barrel burst the instant the round leaves.
        if (flash > 0) this.m_particles.muzzleFlash(muzzlePos.x, muzzlePos.y, d.x, d.y, flash, col);
        // SMOKE a beat later — it emerges as the flash dies (flash → smoke), never together.
        if (muSmoke > 0) {
          const mx = muzzlePos.x,
            my = muzzlePos.y;
          this.schedule(0.06, () => this.m_particles.muzzleSmoke(mx, my, d.x, d.y, muSmoke, col));
        }
      }
      this.m_pendingSalvos = Math.max(0, this.m_pendingSalvos - 1);
    };

    const salvos = 1 + weapon.getSuccessionCount();
    // Succession cadence: the original queues each extra salvo `sucSec` apart, where
    // `sucSec` rides the reference engine's ballistic time-step (the same one `batSec`
    // uses) — so `REF_TIME_SCALE` converts it to our seconds. Salvo k fires at k·gap, a
    // FIXED per-salvo interval (not `sucSec/salvos`, which stretched fast bursts and
    // rushed slow ones). Floor keeps a pathological 0 from stacking every salvo on frame 0.
    const loudSuccession = weapon.getSuccessionSec() > SUCCESSION_LOUD_MAX_SEC;
    const gap = salvos > 1 ? Math.max(0.02, weapon.getSuccessionSec() * REF_TIME_SCALE) : 0;
    this.m_pendingSalvos = salvos;
    for (let sv = 0; sv < salvos; sv++) {
      if (sv === 0) fireSalvo(true);
      else
        this.schedule(gap * sv, () => {
          // Slow successions re-bark each salvo (the gap clears the SFX retrigger
          // throttle so each is audible); fast bursts stay silent after the opener.
          if (loudSuccession) this.m_audio?.fire(weapon.getFireSound(), tank.getPosition().x);
          fireSalvo(loudSuccession);
        });
    }

    this.m_gameState = EGameState.ShotFlying;
  }

  /**
   * Resolve a beam weapon as an instantaneous ray: march muzzle → first
   * terrain/edge, damage every tank the line crosses (once, full damage — beams
   * ignore falloff), carve + scorch the impact, flash a line.
   */
  private fireBeam(muzzle: Vec2, angleRad: number, weapon: CWeapon, owner: CTank): void {
    // Aim unit vector — same unified convention as the projectile velocity so the
    // beam points exactly where the turret does (screen-Y down, up-aim → negative y).
    const dir = new Vec2(Math.cos(angleRad), -Math.sin(angleRad));

    // A beam PENETRATES terrain — it does NOT stop at the first hill. March to the
    // far edge of the world so the ray cuts clean across the map (through mountains,
    // reaching tanks buried behind them).
    const W = this.m_land.width,
      H = this.m_land.height;
    const maxLen = Math.hypot(W, H) + 200;
    let end = muzzle.clone();
    for (let d = 0; d <= maxLen; d += 4) {
      const px = muzzle.x + dir.x * d,
        py = muzzle.y + dir.y * d;
      end = new Vec2(px, py);
      if (px < -40 || px > W + 40 || py > H + 40 || py < -60) break; // left the world
    }

    // Damage every living tank within the beam's half-width of the FULL line — once
    // each, full damage (no falloff), including tanks behind terrain it pierced. The
    // shooter is EXCLUDED: the ray starts at its own muzzle, so it would otherwise sit
    // inside the half-width at the origin and take self-damage on every shot.
    const r = weapon.getRadius();
    const halfWidth = Math.max(8, r * 0.5) + 16; // + tank radius
    for (const t of this.m_tanks) {
      if (!t.isAlive() || t === owner) continue;
      const tp = t.getPosition();
      if (CGameController.pointSegDist(tp.x, tp.y, muzzle.x, muzzle.y, end.x, end.y) > halfWidth)
        continue;
      const removed = t.hit(weapon.getDamage());
      this.creditDamage(owner, t, removed); // shooter earns per life removed
      this.kickTank(t, muzzle.x, removed, r); // beam kick scaled by the weapon's radius
      if (!t.isAlive()) this.handleTankDestroyed(t);
    }

    // The beam itself: the weapon's own colour texture (`bitmap` — red magma, striped
    // yellow grate, blue …) rotated to the aim and tiled end-to-end along the line at
    // `size` thickness. It holds on screen for a beat, THEN the earth collapses — a
    // through-beam has no single impact point, no crater/explosion/ripple, just a shake.
    this.m_particles.beam(
      muzzle.x,
      muzzle.y,
      end.x,
      end.y,
      weapon.getColor(),
      `weapons/${weapon.getBitmap()}`,
      weapon.getSize(),
      BEAM_COLLAPSE_DELAY,
    );
    this.shake(3, 0.18);

    // The earth falls AFTER the beam, not with it: the original cuts once but the
    // removed dirt drops and settles over the following ~second, so it reads as
    // "beam holds → ground collapses". We schedule the slice to fire as the beam
    // fades. It cuts a SLICE the width of the beam (the overburden falls in — never
    // planing off everything from the ray up to the surface) with a per-fire width
    // jitter + ragged per-column depth + falling debris, so the collapsed line is
    // noisy, not a clean geometric slot. Our heightmap can't hold a floating tunnel,
    // so the slice drops each crossed column by ~the beam thickness.
    const jitter = 0.85 + this.m_rng.float() * 0.3; // per-fire size wobble
    const carveHalf = clamp(weapon.getSize() * 0.5 * jitter, 3, 24);
    this.schedule(BEAM_COLLAPSE_DELAY, () => {
      this.m_land.carveBeamSlice(muzzle.x, muzzle.y, end.x, end.y, carveHalf);
    });

    const rad = weapon.getRadiation();
    if (rad.time > 0 && rad.dmg > 0) {
      // Fallout spreads within the blast radius, not by `iradiate` — iradiate is
      // only the on/off gate, never a spatial scale (see WeaponBehavior.weaponDetonate).
      const zoneR = r;
      this.m_land.blastIradiate(
        Math.floor(end.x),
        Math.floor(this.m_land.getHeightAt(end.x)),
        zoneR,
        rad.dmg * 60,
        rad.time,
        rad.rgb,
      );
    }
  }

  /** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
  private static pointSegDist(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / len2) : 0;
    const cx = ax + t * dx,
      cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /**
   * Utility items (extType 7/10/11/14) modify the firing tank on use rather than
   * firing a projectile — the "use item" handler. Handles the known effects;
   * 3/15/17 are left as no-ops.
   * Returns true if the weapon was a utility (and consumed the turn).
   */
  private applyUtility(tank: CTank, weapon: CWeapon, ext: ExtType): boolean {
    const v = weapon.getDamage(); // the effect magnitude lives in the damage field
    switch (ext) {
      case EXT.SHIELD:
        tank.addShield(v);
        return true; // shield boost
      case EXT.HEAL:
        tank.addLife(v);
        return true; // repair
      case EXT.ARMOR:
        tank.setArmor(v);
        return true; // SET armor % (a level, not additive — does not stack)
      case EXT.HAZMAT:
        tank.setHazmat(v);
        return true; // SET hazmat % (piercing/secondary resist; a level, not additive)
      case EXT.BUNKER_WALL: {
        // Terrain tool: raise a solid structure at the aim point, TEXTURED with its own
        // bitmap (Wall = tall/narrow shield; Bunker = wider/shorter emplacement). The bitmap
        // sizes the platform and paints its visible face, so it reads as the real art. Falls
        // back to a bare dirt platform sized to the known bmp dims if the sprite isn't ready.
        const aim = this.aimPoint(this.m_angle, this.m_power);
        // The structure bitmap is scaled DOWN (the original does not stamp it at native size —
        // that yields a tower several tanks tall). Scale it to read proportionate to the tank,
        // tracking Player Size. bunker.bmp 40×118 → ~18×53, wall.bmp 30×200 → ~14×90.
        const sc = STRUCTURE_SCALE * GameConfig.tankSizeScale;
        const img = this.structureImage(weapon.getBitmap(), sc);
        if (img) this.m_land.buildStructure(Math.round(aim.x), img);
        else {
          const isWall = /wall/i.test(weapon.getName?.() ?? '');
          this.m_land.buildPlatform(
            Math.round(aim.x),
            Math.round((isWall ? 30 : 40) * sc * 0.5),
            Math.round((isWall ? 200 : 118) * sc),
          );
        }
        return true;
      }
      // extType 17 (jet) is handled in fire() before this — flight, not a no-op.
      default:
        return false;
    }
  }

  // ========================================================================
  // SENTRY TURRETS (auto-firing deployables)
  // ========================================================================

  /** The nearest living enemy (different team) to a tank, or null if none remain. */
  private nearestEnemy(from: CTank): CTank | null {
    const p = from.getPosition();
    let best: CTank | null = null;
    let bestDist = Infinity;
    for (const t of this.m_tanks) {
      if (t === from || !t.isAlive()) continue;
      if (t.getTeamId() === from.getTeamId()) continue; // never target its own team
      const d = t.distanceTo(p.x, p.y);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }

  /** A Sentry's turn: lock the turret onto the nearest enemy and fire in a direct line
   *  at full power — the Turret variant shoots a Shell, the Minigun variant a Machine Gun
   *  burst. No ballistic solve (it "can only fire in a direct line"), so it can miss over
   *  terrain. With no enemy left it simply passes. */
  /** UI aim-angle (0..359, screen-up = 90) from `pivot` toward `target` — the barrel points
   *  along (cos θ, −sin θ) with screen-Y down, so it's atan2(−dy, dx) folded into range. */
  private aimDegToward(pivot: Vec2, target: Vec2): number {
    return wrapIndex(
      Math.round(rad2deg(Math.atan2(-(target.y - pivot.y), target.x - pivot.x))),
      360,
    );
  }

  /** Push an aim onto `tank` and mirror it into the controller's live angle/power. */
  private commitAim(tank: CTank, angleDeg: number, power: number): void {
    tank.setAimAngle(angleDeg);
    tank.setPower(power);
    tank.setTurretAngle(angleDeg);
    this.m_angle = angleDeg;
    this.m_power = power;
  }

  /** Living tanks on an enemy team of `tank` (never its own squad). */
  private enemiesOf(tank: CTank): CTank[] {
    return this.m_tanks.filter(t => t.isAlive() && t.getTeamId() !== tank.getTeamId());
  }

  /** Living SQUADMATES of `tank` — its own team, itself excluded. */
  private alliesOf(tank: CTank): CTank[] {
    return this.m_tanks.filter(
      t => t !== tank && t.isAlive() && !t.isSentry() && t.getTeamId() === tank.getTeamId(),
    );
  }

  /** A tank's standing in the race the battle is actually scored on — the same measure
   *  {@link getLeadingTeam} ranks teams by, so a bot judging "who's winning" reads the real board. */
  private tankScore(t: CTank): number {
    return this.m_gameType === EGameType.Rounds ? t.getDamageDealt() : t.getKills();
  }

  /** Angular offset of round `i` within a `rounds`-wide fan spaced `spacingRad` apart
   *  (centred: a lone round fires dead-centre, a 3-fan spreads −1,0,+1 × spacing). */
  private fanOffset(i: number, rounds: number, spacingRad: number): number {
    return rounds > 1 ? (i - (rounds - 1) / 2) * spacingRad : 0;
  }

  /** A weapon's on-screen blast radius: raw radius × Explosion-Size setting × resolution scale. */
  private scaledBlastRadius(w: CWeapon): number {
    return w.getRadius() * GameConfig.explosionScale * this.blastScale;
  }

  /** Select `tank`'s weapon and mirror it into the controller's current-weapon index. */
  private setCurrentWeapon(tank: CTank, index: number): void {
    this.setSquadWeapon(tank, index);
    this.m_currentWeaponIndex = index;
  }

  /** Persist a weapon choice on `tank`, and — with Weapon Persistence on (Gameplay) — onto every
   *  squadmate (same team) too, making the pick the PLAYER's rather than the individual tank's: the
   *  squad's next tank then opens its turn on the weapon the player last chose instead of on
   *  whatever that tank happened to fire several turns ago. A local human squad buys from one
   *  shared depot, so the inherited pick is in stock by construction; where inventories are
   *  per-tank (bots, net) beginTurn's ensureStocked drops it back to the staple.
   *  Sentries are excluded both ways — they fire a fixed weapon (Shell / Machine Gun) and must
   *  neither inherit their owner's pick nor overwrite it. */
  private setSquadWeapon(tank: CTank, index: number): void {
    tank.setWeaponIndex(index);
    if (!GameConfig.weaponPersist || tank.isSentry()) return;
    const team = tank.getTeamId();
    for (const t of this.m_tanks) {
      if (t !== tank && !t.isSentry() && t.getTeamId() === team) t.setWeaponIndex(index);
    }
  }

  /** If the current weapon is out of stock, fall back to the unlimited staple (Shell) and
   *  persist it on `tank` — so a turn never opens on, nor a shot fires from, an empty weapon.
   *  The caller decides WHEN to check (human turn-start vs a chargeable-ammo shot). */
  private ensureStocked(tank: CTank): void {
    if (this.economyFor(tank).hasStock(this.m_currentWeaponIndex)) return;
    this.setCurrentWeapon(tank, getDefaultWeaponIndex());
  }

  /** The inventory a tank fires/buys from. Solo: the shared human depot (m_economy) or a bot's
   *  own lazily-created loadout. NET: EVERY tank owns its economy, so a relayed buy/sell hits the
   *  buyer's inventory + credits on every client (credits then stay identical across the room).
   *  Each per-tank economy is bound to that tank's credits and stocked with the Shell staple. */
  private economyFor(tank: CTank): CEconomy {
    if (!this.m_netMode && tank.isHuman()) return this.m_economy;
    let e = this.m_botEconomy.get(tank);
    if (!e) {
      e = new CEconomy(this.m_startCredits);
      e.setSellRate(this.m_sellRate); // shared refund rate (net) / local (solo bots)
      e.bindCredits(tank); // spend against the tank's own credits
      this.m_botEconomy.set(tank, e);
    }
    return e;
  }

  /** The economy the DEPOT operates on — always the ACTIVE player's (buying happens on your own
   *  turn, so getCurrentTank() is you; a relayed buy applies on the buyer's turn on every peer). */
  private activeEconomy(): CEconomy {
    return this.economyFor(this.getCurrentTank());
  }

  /** Does `econ` own any weapon of this extType? */
  private botOwnsExt(econ: CEconomy, ext: number): boolean {
    return WEAPON_DATABASE.some(w => (w.extType ?? 0) === ext && econ.getOwned(w.index) > 0);
  }

  /** Buy one random enabled weapon of `ext`, only if credits cover `afford ×` its cost (the
   *  original guards support buys with a 2–2.5× affordability margin). Returns whether it bought. */
  private botBuyOneOfExt(econ: CEconomy, ext: number, afford: number): boolean {
    const cands = WEAPON_DATABASE.filter(
      w =>
        (w.extType ?? 0) === ext &&
        w.cost > 0 &&
        weaponEnabled(w.index) &&
        econ.getCredits() >= w.cost * afford,
    );
    if (!cands.length) return false;
    return econ.buy(cands[Math.floor(Math.random() * cands.length)].index);
  }

  /**
   * The AI restock: a difficulty-gated DEFENSIVE front-load — shield/heal (L>5),
   * armor (L>6), Death's-head (L>7), mine (L>4), move (L>3), each bought once only when the bot
   * doesn't own it and the matching need-stat is low — then an offensive drain that stocks a varied
   * assortment (conserving toward cheap filler at high level). Called at turn start when the bot's
   * finite stock has run low, so higher-difficulty bots actually turtle up and vary their arsenal.
   */
  private aiRestock(tank: CTank, econ: CEconomy): void {
    const L = this.m_difficulty;
    const h = tank.getHealth();
    const maxLife = tank.getMaxLife();
    if (L > 5 && !this.botOwnsExt(econ, 7) && h.nShield < BOT_SHIELD_NEED)
      this.botBuyOneOfExt(econ, 7, 2);
    if (L > 5 && !this.botOwnsExt(econ, 10) && h.nLife < maxLife * 0.7)
      this.botBuyOneOfExt(econ, 10, 2);
    if (L > 6 && !this.botOwnsExt(econ, 11) && h.nArmor === 0) this.botBuyOneOfExt(econ, 11, 2.5);
    if (L > 7 && !this.botOwnsExt(econ, 12)) this.botBuyOneOfExt(econ, 12, 2.5);
    if (L > 4 && !this.botOwnsExt(econ, 16)) this.botBuyOneOfExt(econ, 16, 2.5);
    if (L > 3 && !this.botOwnsExt(econ, 3)) this.botBuyOneOfExt(econ, 3, 2.5);
    // Offensive drain: high-level bots conserve (buy cheap filler), but ULTRA does NOT — it stocks a
    // strong, varied arsenal so its expected-value planner actually has heavy/area/gas rounds to fire.
    econ.autoBuy({conserve: L > 6 && L < AI_LEVEL_ULTRA});
    // Re-sync the bot's SQUAD to its debited balance (each bot spends its own economy) — else a
    // squad-mate's later earn would pool its stale, undebited balance back and refund the restock.
    // No-op for a 1-tank team (the common case). Mirrors buyWeapon's poolActiveCredits (ECON-1).
    this.poolTeamCredits(tank);
  }

  // ── ULTRA economy: buy the LEVERAGE weapons (nuke / beam / gas) and spend down, not hoard ────────
  private static readonly ULTRA_CREDIT_RESERVE = 150; // small reserve; the rest gets spent on firepower
  private static readonly ULTRA_OFFENSE_STOCK = 6; // keep this many offensive rounds on hand
  private static readonly ULTRA_SURROUND_RADIUS = 260; // "surrounded" if ≥2 enemies within this (kamikaze)

  /** A true NUKE — an expensive BALLISTIC blast worth reserving/ranging (not a mid-tier round like
   *  Hercules/Roller, and not a beam/death/utility). Only these are ever measured with a Shell first. */
  private isNukeWeapon(i: number): boolean {
    const w = getWeapon(i);
    const ext = WEAPON_DATABASE[i].extType ?? 0;
    if (BOT_UTILITY_EXT.has(ext) || isBeamExt(w.getExtType())) return false; // not death/mine/utility/beam
    // By DAMAGE, not cost — a $1200 seeker (dmg 200) is NOT a nuke; a.bomb/hydrogen/plutonium/uranium are.
    return w.isNukeClass() || w.getDamage() >= CGameController.ULTRA_NUKE_DAMAGE;
  }
  private isBeamWeapon(i: number): boolean {
    return isBeamExt(getWeapon(i).getExtType());
  }
  /** A sub-premium RADIATION/gas round (lays a fallout zone) — area denial that forces the foe to move. */
  private isRadWeapon(i: number): boolean {
    return getWeapon(i).getRadiation().dmg > 0 && !this.isNukeWeapon(i);
  }
  private botOwnsMatching(econ: CEconomy, pred: (i: number) => boolean): boolean {
    for (let i = 0; i < WEAPON_DATABASE.length; i++)
      if (!econ.isUnlimited(i) && econ.getOwned(i) > 0 && pred(i)) return true;
    return false;
  }

  /**
   * Ultra's per-turn economy. It SPENDS to win, not hoard: minimal reactive defence, then a real
   * arsenal of LEVERAGE weapons — a NUKE (big damage to force the issue), a BEAM (fire while buried),
   * a GAS/RADIATION round (area denial that makes the foe move) — then fill with strong varied rounds
   * until stocked, draining down to a tiny reserve. This is what makes two Ultra bots actually finish
   * a fight instead of chipping + healing forever.
   */
  private ultraManageEconomy(tank: CTank, econ: CEconomy): void {
    const h = tank.getHealth();
    const maxLife = tank.getMaxLife();
    const onRad = this.m_land.radiationAt(Math.floor(tank.getPosition().x));
    const R = CGameController.ULTRA_CREDIT_RESERVE;
    // BURIED — top priority, ahead of everything else: a pinned tank can't drive and can't fire a
    // normal round without eating its own blast, so nothing else in the shop matters until it's out.
    // A cleaner (earth-remover, no damage) is the clean way out, and bestCleanSelf can only pick one
    // that's actually in stock — the economy never bought one, so that escape was dead on arrival.
    // Ignores the reserve: being stuck costs far more than the credits do.
    if (tank.isBuried() && !this.botOwnsMatching(econ, i => getWeapon(i).isCleaner()))
      this.ultraBuyMatching(econ, i => getWeapon(i).isCleaner(), false);
    // Buy a HEAL as soon as it's hurt (< 60%) and holds none — so a heal is in stock BEFORE it gets
    // critical, and a bot with money always has the self-heal option the desperation curve will use.
    if (h.nLife < maxLife * 0.6 && !this.botOwnsExt(econ, 10)) this.botBuyOneOfExt(econ, 10, 1); // heal
    if (h.nArmor <= 0 && !this.botOwnsExt(econ, 11)) this.botBuyOneOfExt(econ, 11, 1); // armor
    if (onRad && h.nHazmat <= 0 && !this.botOwnsExt(econ, 14)) this.botBuyOneOfExt(econ, 14, 1); // hazmat

    // COUNTER-NUKE DOCTRINE. Weapons are visible, so read the other side's arsenal before spending:
    // once they hold nuke-class ordnance, the answer is not to race them to a bigger one — it's to make
    // their nuke miss. That means a BEAM (a straight ray that still reaches them once we're under the
    // dirt, and the one weapon a buried tank can fire) and a cheap DIRT round to pull that dirt over
    // ourselves with. Bought AHEAD of our own nuke savings, because a nuke we can't live long enough to
    // fire is worth nothing. Skipped if they hold a beam too — then dirt hides us from nobody.
    const threat = this.ultraThreatAgainst(tank);
    if (threat.hasNuke && !threat.hasBeam) {
      if (!this.botOwnsMatching(econ, i => this.isBeamWeapon(i)))
        this.ultraBuyMatching(econ, i => this.isBeamWeapon(i), false);
      // Only worth a dirt round if we actually got the beam — otherwise burying is just hiding in a hole.
      if (
        this.botOwnsMatching(econ, i => this.isBeamWeapon(i)) &&
        !this.botOwnsMatching(econ, i => getWeapon(i).getEarth() >= SELF_BURY_MIN_EARTH)
      )
        this.ultraBuyMatching(econ, i => getWeapon(i).getEarth() >= SELF_BURY_MIN_EARTH, false);
    }

    // A DEATH (kamikaze) round FIRST when SURROUNDED — 2+ enemies close, so dying takes them with it.
    // Priority (bought before the pricey nuke can drain the purse); pointless/skipped when spread out.
    if (
      econ.getCredits() > R &&
      this.ultraEnemiesWithin(tank, CGameController.ULTRA_SURROUND_RADIUS) >= 2 &&
      !this.botOwnsMatching(econ, i => (WEAPON_DATABASE[i].extType ?? 0) === 12)
    )
      this.ultraBuyMatching(econ, i => (WEAPON_DATABASE[i].extType ?? 0) === 12, false);

    // Leverage weapons — a NUKE (cheapest true nuke, so it affords one AND keeps credits for variety —
    // not blowing the whole purse on the single priciest), then a BEAM, then a GAS round.
    if (econ.getCredits() > R && !this.ultraOwnsPremium(econ))
      this.ultraBuyMatching(econ, i => this.isNukeWeapon(i), false);
    if (econ.getCredits() > R && !this.botOwnsMatching(econ, i => this.isBeamWeapon(i)))
      this.ultraBuyMatching(econ, i => this.isBeamWeapon(i), false);
    if (econ.getCredits() > R && !this.botOwnsMatching(econ, i => this.isRadWeapon(i)))
      this.ultraBuyMatching(econ, i => this.isRadWeapon(i), false);
    // A MINE for area denial (cheapest); one is enough.
    if (
      econ.getCredits() > R &&
      !this.botOwnsMatching(econ, i => (WEAPON_DATABASE[i].extType ?? 0) === 16)
    )
      this.ultraBuyMatching(econ, i => (WEAPON_DATABASE[i].extType ?? 0) === 16, false);

    // SAVE toward a nuke: if the bot doesn't hold a real nuke yet, STOP here — don't fritter credits on
    // cheap fill; let the balance build up so it can buy a nuke ($4000+) in a turn or two. Only once a
    // nuke is in the bag does it fill out with strong varied rounds (spending down to the small reserve).
    let guard = 0;
    while (
      this.ultraOwnsPremium(econ) &&
      this.ultraFiniteOffense(econ) < CGameController.ULTRA_OFFENSE_STOCK &&
      econ.getCredits() > R &&
      guard++ < 24
    ) {
      if (!this.ultraBuyBestOffense(econ, econ.getCredits())) break;
    }
    // Re-sync the squad to the debited balance (see aiRestock) so a teammate's earn can't refund this.
    this.poolTeamCredits(tank);
  }

  /** Count of finite (non-Shell) OFFENSIVE rounds a bot holds — the "do I have real firepower?" gauge. */
  private ultraFiniteOffense(econ: CEconomy): number {
    let n = 0;
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      if (econ.isUnlimited(i) || econ.getOwned(i) <= 0) continue;
      const w = WEAPON_DATABASE[i];
      if ((w.damage ?? 0) > 0 && !BOT_UTILITY_EXT.has(w.extType ?? 0)) n += econ.getOwned(i);
    }
    return n;
  }

  /** Does the bot already hold a premium (nuke-class / pricey) round? */
  private ultraOwnsPremium(econ: CEconomy): boolean {
    return this.botOwnsMatching(econ, i => this.isNukeWeapon(i));
  }

  /** Buy the best affordable weapon matching `pred` — the strongest (highest damage) if `strongest`,
   *  else the cheapest. Used to guarantee a specific class (nuke / beam / gas) actually gets bought,
   *  unlike the weighted-random fill. Returns whether it bought. */
  private ultraBuyMatching(
    econ: CEconomy,
    pred: (i: number) => boolean,
    strongest: boolean,
  ): boolean {
    const cands: number[] = [];
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      const w = WEAPON_DATABASE[i];
      const cost = w.cost ?? 0;
      if (cost <= 0 || cost > econ.getCredits() || !weaponEnabled(i)) continue;
      if (pred(i)) cands.push(i);
    }
    if (!cands.length) return false;
    cands.sort((a, b) =>
      strongest
        ? (WEAPON_DATABASE[b].damage ?? 0) - (WEAPON_DATABASE[a].damage ?? 0)
        : (WEAPON_DATABASE[a].cost ?? 0) - (WEAPON_DATABASE[b].cost ?? 0),
    );
    return econ.buy(cands[0]);
  }

  /** Buy an affordable OFFENSIVE weapon costing ≤ maxCost, picked at RANDOM but weighted toward higher
   *  damage — so Ultra stocks a VARIED arsenal (not four of the single strongest round) and its firing
   *  actually differs turn to turn. Skips utilities/self-buffs. Returns whether it bought. */
  private ultraBuyBestOffense(econ: CEconomy, maxCost: number): boolean {
    const cands: number[] = [];
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      const w = WEAPON_DATABASE[i];
      const cost = w.cost ?? 0;
      if (cost <= 0 || cost > maxCost || cost > econ.getCredits()) continue;
      if (!weaponEnabled(i) || (w.damage ?? 0) <= 0 || BOT_UTILITY_EXT.has(w.extType ?? 0))
        continue;
      cands.push(i);
    }
    if (!cands.length) return false;
    // Weight ∝ damage² so heavy rounds are favoured, but lighter ones still get bought — a real mix.
    const weights = cands.map(i => Math.pow(WEAPON_DATABASE[i].damage ?? 1, 2));
    let r = this.m_rng.float() * weights.reduce((a, b) => a + b, 0);
    let pick = cands[cands.length - 1];
    for (let k = 0; k < cands.length; k++) {
      r -= weights[k];
      if (r <= 0) {
        pick = cands[k];
        break;
      }
    }
    return econ.buy(pick);
  }

  /** Owned weapon indices for a tank's inventory (the Shell staple always included). */
  private ownedWeaponIndices(econ: CEconomy): number[] {
    const out: number[] = [];
    for (let i = 0; i < WEAPON_DATABASE.length; i++) if (econ.getOwned(i) > 0) out.push(i);
    return out;
  }

  /** Finite rounds a tank has in stock (excludes the unlimited Shell) — the restock trigger. */
  private botFiniteStock(econ: CEconomy): number {
    let n = 0;
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      if (econ.isUnlimited(i)) continue;
      const c = econ.getOwned(i);
      if (Number.isFinite(c)) n += c;
    }
    return n;
  }

  private executeSentryTurn(): void {
    const sentry = this.getCurrentTank();
    if (!sentry.isAlive() || this.m_gameState !== EGameState.Battle) return;
    if (!sentry.isSentry()) return;

    const target = this.nearestEnemy(sentry);
    if (!target) {
      this.endTurn();
      return;
    }

    // Aim straight at the target, then commit the aim + weapon (as a bot would).
    const norm = this.aimDegToward(sentry.getTurretPivot(), target.getPosition());
    this.commitAim(sentry, norm, SENTRY_FIRE_POWER);
    const wi = this.m_sentryMinigun.has(sentry) ? sentryMachineGunIndex() : getDefaultWeaponIndex();
    this.setCurrentWeapon(sentry, wi);

    // Fire after a brief beat; the shot resolving hands the turn on (as for a bot).
    this.schedule(0.4, () => this.fire());
  }

  // ========================================================================
  // BOT AI (CPU PLAYER)
  // ========================================================================

  /** Execute bot player's turn (AI calculation and firing). */
  private executeBotTurn(): void {
    // A settled battle or an in-flight shot must not be restarted by a stale queued bot turn: botMove→
    // startTankMove sets state back to Battle, so — unlike its siblings botAimAndFire/executeUltraTurn/
    // executeSentryTurn, which all re-check — an unguarded executeBotTurn could un-finish a battle.
    if (this.m_gameState !== EGameState.Battle) return;
    const botTank = this.getCurrentTank();

    // A Sentry drives its own turn (aim + direct-line fire), never the normal bot solve.
    if (botTank.isSentry()) {
      this.executeSentryTurn();
      return;
    }

    // In Demo Mode the AI also drives the human tank, so allow a non-bot through then.
    if (!botTank.isAlive() || (!botTank.isBot() && !GameConfig.demo)) return;

    // Nothing to shoot at if no ENEMY-team tank is left alive (teammates aren't targets).
    if (this.m_tanks.every(t => !t.isAlive() || t.getTeamId() === botTank.getTeamId())) {
      this.endTurn();
      return;
    }

    // Restock the bot's loadout. Levels 1-10: a difficulty-scaled buy only when finite stock runs low
    // (the original's < 5 trigger). ULTRA: an every-turn economy pass that actually SPENDS its credits
    // like a player — buy defense when a stat is low, keep strong offensive rounds in stock, and bank
    // toward a nuke — instead of hoarding thousands while it fires the free Shell.
    if (botTank.isBot()) {
      const econ = this.economyFor(botTank);
      if (this.m_difficulty === AI_LEVEL_ULTRA) this.ultraManageEconomy(botTank, econ);
      else if (this.botFiniteStock(econ) < 5) this.aiRestock(botTank, econ);
    }

    // ULTRA (level 11): a wholly different brain — score every possible action (best expected-value
    // shot, crate grab, radiation flee, reposition, self-buff) and take the best. No random move.
    if (this.m_difficulty === AI_LEVEL_ULTRA) {
      this.executeUltraTurn(botTank);
      return;
    }

    // A bot's turn is ONE action: MOVE or FIRE (mutually exclusive) — spending
    // the turn on a Move Near/Mid/Far utility drives the tank and ends the turn
    // (no shot). Otherwise it aims and fires.
    if (Math.random() < CGameController.BOT_MOVE_CHANCE && this.botMove(botTank)) return;
    this.botAimAndFire(botTank);
  }

  // Chance a bot spends its whole turn moving instead of firing.
  private static readonly BOT_MOVE_CHANCE = 0.25;

  /**
   * Bot move action: pick a Move utility, drive to a random spot within its range,
   * and end the turn. Returns false when the move can't actually happen (→ fall back
   * to fire) — a committed drive that covers no ground burns the whole turn on nothing,
   * because startTankMove's waitForRest ends the turn the moment the tank isn't moving.
   */
  private botMove(botTank: CTank): boolean {
    // A BURIED tank can't drive at all (startDrive refuses until it's dug out), so a move roll here
    // used to end the turn instantly with no action whatsoever. Fire instead — the round detonates in
    // the dirt around the tank and blasts it free, which is the only way it gets out.
    if (botTank.isBuried()) return false;
    const wi = pickMoveWeapon();
    if (wi < 0) return false;
    const weapon = getWeapon(wi);

    const maxDist = this.moveRange(weapon);
    const x = botTank.getPosition().x;
    const dist = (0.4 + Math.random() * 0.6) * maxDist;
    // Pick a direction that has ROOM. Bots drift into the edge clamp over a match and park there; a
    // blind 50/50 roll into the wall then clamps the destination onto the tank's own position and it
    // "drives" zero pixels. Try the random direction first, then the other, and give up if neither
    // has room (a very short map) rather than spending the turn standing still.
    const first = Math.random() < 0.5 ? -1 : 1;
    for (const dir of [first, -first]) {
      const destX = this.clampMoveDest(x + dir * dist);
      if (Math.abs(destX - x) < CGameController.BOT_MOVE_MIN_DIST) continue;
      this.setCurrentWeapon(botTank, wi);
      this.startTankMove(botTank, destX);
      return true;
    }
    return false;
  }

  // A bot drive shorter than this isn't worth a whole turn — roll the other way (or fire) instead.
  private static readonly BOT_MOVE_MIN_DIST = 8;
  // Tanks never drive right up to the world edge; every drive destination is clamped into this inset.
  private static readonly MOVE_EDGE_MARGIN = 20;

  /** Clamp a drive destination into the drivable strip of the map. */
  private clampMoveDest(destX: number): number {
    const m = CGameController.MOVE_EDGE_MARGIN;
    return clamp(destX, m, this.m_land.width - m);
  }

  /** Max move distance for a Move utility: landscape width × (move power / 100). */
  private moveRange(weapon: CWeapon): number {
    return this.m_land.width * (weapon.getDamage() / 100);
  }

  /** Drive a tank to `destX` (a Move utility action), then end the turn once settled. */
  private startTankMove(tank: CTank, destX: number): void {
    const clamped = this.clampMoveDest(destX);
    // Network: a Move is a turn-resolving action just like a shot — flag it busy so the next
    // hand-off (and any keyframe that arrives mid-drive) HOLDS until the drive settles. Without
    // this the drive is ungated: a peer whose sim is throttled (backgrounded tab) would reconcile
    // an incoming turn-end snapshot against its not-yet-driven tank and flag a false desync (or, on
    // its first action, adopt a snapshot it should detect). endTurn clears it once waitForRest
    // settles — the same seam fire() uses. Covers placeMove, the peer replay (commandMoveTo) and bots.
    if (this.m_netMode) this.m_netShotResolving = true;
    this.m_moveResolving = true; // committed drive → keep the green move-area hidden until turn-begin
    tank.startDrive(clamped);
    this.m_gameState = EGameState.Battle;
    this.waitForRest(tank, tank.getPosition().x, 0);
  }

  /** Poll until the moving tank has actually STOPPED, then end the turn. A long drive must NOT be cut
   *  short: the old fixed 5s cap ended the turn mid-move, handing the NEXT tank its turn (and a shot)
   *  while this one was still driving. So we wait as long as it's making progress; only a genuine hang
   *  — still flagged `moving` yet frozen in place for a sustained spell — bails out. */
  private waitForRest(tank: CTank, lastX: number, stuckPolls: number): void {
    if (!tank.isMoving()) {
      this.endTurn();
      return;
    }
    const x = tank.getPosition().x;
    const stuck = Math.abs(x - lastX) > 0.25 ? 0 : stuckPolls + 1;
    if (stuck >= 20) {
      this.endTurn(); // ~3s (20 × 0.15s of sim time) with no progress while still "moving" → stuck
      return;
    }
    this.schedule(0.15, () => this.waitForRest(tank, x, stuck));
  }

  /** Pick a target + weapon, solve the firing arc, degrade by difficulty, and fire. */
  private botAimAndFire(botTank: CTank): void {
    if (!botTank.isAlive() || this.m_gameState !== EGameState.Battle) return;
    // Target only ENEMY teams — a squad bot must never aim at its own teammates.
    const enemies = this.enemiesOf(botTank);
    if (enemies.length === 0) {
      this.endTurn();
      return;
    }

    const level = this.m_difficulty;
    const botPos = botTank.getPosition();

    // Pick a target — weakest/nearest at high difficulty IN DEATHMATCH, random otherwise (a
    // Points/Rounds bot targets randomly, matching the original's game-mode gate on the split).
    const ti = pickTarget(
      enemies.map(e => {
        const p = e.getPosition();
        return {
          x: p.x,
          y: p.y,
          healthFrac: clamp01(e.getHealth().nLife / e.getMaxLife()),
        };
      }),
      botPos.x,
      botPos.y,
      level,
      this.m_gameType === EGameType.Deathmatch,
    );
    const target = enemies[Math.max(0, ti)];
    const tp = target.getPosition();

    // Whether the bot computes a FRESH firing solution this turn. Low-skill bots often don't
    // (they fire with their stale aim); a ranging shot is forced in ROUND 1 of EVERY battle for any
    // half-decent bot — keyed on the per-battle round counter (reset each battle), NOT the battle
    // number. `solutionFound` = the solved arc actually reaches the target (so the no-arc fallback
    // in the weapon choice is skipped).
    const willAim =
      Math.random() < aimProbability(level) || (this.m_currentRound === 1 && level > 3);
    let ballisticAngle: number;
    let ballisticPower: number;
    let solutionFound = false;
    if (willAim) {
      const field = {
        heightAt: (x: number) => this.m_land.getHeightAt(x),
        width: this.m_land.width,
        height: this.m_land.height,
      };
      const aim = bestAim(
        deg => botTank.muzzleForAngle(deg),
        {x: tp.x, y: tp.y},
        this.m_wind,
        field,
        // Predict the gust phase AT LAUNCH: the shot fires after the fixed "thinking" delay, during
        // which the gust clock keeps ticking. Passing the launch-time clock lets the bot lead the
        // gusting Realistic wind instead of aiming at the mean (Linear → gustFactor is flat, no-op).
        this.m_gustT + CGameController.BOT_FIRE_DELAY,
      );
      ballisticAngle = aim.angleDeg;
      ballisticPower = aim.power;
      solutionFound = aim.dist <= target.getHitRadius() + 6; // the arc lands on the target
    } else {
      ballisticAngle = botTank.getAimAngle();
      ballisticPower = botTank.getPower();
    }

    // Choose a weapon or defensive utility from the bot's OWN inventory: a random offensive round,
    // a strongest-weapon upgrade at high skill, a no-arc fallback (Escape/Cleaner/Rebound/Beam)
    // when the solve missed, then a self-buff (shield/heal/armor/hazmat) when a stat is low.
    const h = botTank.getHealth();
    const weaponIndex = chooseBotWeapon(
      this.ownedWeaponIndices(this.economyFor(botTank)),
      level,
      solutionFound,
      {
        shield: h.nShield,
        armor: h.nArmor,
        hazmat: h.nHazmat,
        life: h.nLife,
        maxLife: botTank.getMaxLife(),
      },
    );
    this.setCurrentWeapon(botTank, weaponIndex);
    const ext = getWeapon(weaponIndex).getExtType(); // nominal token (for isBeamExt)
    const extNum = WEAPON_DATABASE[weaponIndex].extType ?? 0; // raw code (for isBotSelfBuff)

    let angleDeg: number;
    let power: number;
    if (isBotSelfBuff(extNum)) {
      // Shield/heal/armor/hazmat apply to the bot itself — no target aim; keep its current aim.
      angleDeg = botTank.getAimAngle();
      power = botTank.getPower();
    } else if (isBeamExt(ext)) {
      // Beams are hitscan: point straight at the target (no ballistic solve), fire at full power.
      angleDeg = this.aimDegToward(botTank.getTurretPivot(), tp);
      power = SENTRY_FIRE_POWER;
    } else {
      // Ballistic: the solved (or stale) arc + the difficulty angle scatter (angle only).
      angleDeg = ballisticAngle + angleError(level);
      power = ballisticPower;
    }

    // Fold into the HUD's 0..359 range; persist on the bot so its aim carries over.
    angleDeg = wrapIndex(Math.round(angleDeg), 360);
    this.commitAim(botTank, angleDeg, Math.round(power));

    // Execute fire after a brief "thinking" delay. The turn ends automatically once the shot
    // resolves (or immediately, for a self-buff utility).
    this.schedule(CGameController.BOT_FIRE_DELAY, () => this.requestFire()); // wind up the reload bar for AI too
  }

  /**
   * ULTRA turn: marshal the world into an {@link UltraCtx}, let the pure planner pick the single
   * best action (fire / crate grab / radiation flee / reposition / self-buff), and execute it.
   */
  private executeUltraTurn(botTank: CTank): void {
    if (!botTank.isAlive() || this.m_gameState !== EGameState.Battle) return;
    const enemies = this.enemiesOf(botTank);
    if (enemies.length === 0) {
      this.endTurn();
      return;
    }

    const ctx = this.buildUltraCtx(botTank, enemies);
    const plan = planUltraTurn(ctx);

    if (plan.action === 'move') {
      // Drive to the planned spot with a Move utility (grab a crate / flee radiation / reposition).
      // Moving changes the firing geometry, so the old ranging memory is stale — drop it.
      this.m_ultraShot.delete(botTank);
      const moveWi = this.bestMoveWeaponIndex();
      if (moveWi >= 0) this.setCurrentWeapon(botTank, moveWi);
      this.startTankMove(botTank, plan.destX);
      return;
    }

    if (plan.action === 'skip') {
      this.endTurn();
      return;
    }

    // fire | buff: select the weapon, commit the aim, fire after the "thinking" delay.
    this.setCurrentWeapon(botTank, plan.weaponIndex);
    if (plan.action === 'fire') {
      // Range off the last shot's observed miss (drift the solver can't foresee): while still on the
      // same target, KEEP the same weapon + angle and only walk the POWER, so the arc is consistent and
      // converges (a different weapon or a fresh solver angle each turn would scatter the landing and it
      // could never dial in). A new target starts fresh with the planner's explored pick. The record's
      // landedX is unset so this shot's own landing pairs with the aim just fired.
      const aim = this.ultraRangedAim(botTank, plan);
      this.setCurrentWeapon(botTank, aim.weaponIndex);
      this.m_ultraShot.set(botTank, {
        targetX: plan.targetX,
        weapon: aim.weaponIndex,
        angle: aim.angleDeg,
        power: aim.power,
      });
      this.commitAim(botTank, wrapIndex(Math.round(aim.angleDeg), 360), Math.round(aim.power));
      this.schedule(CGameController.BOT_FIRE_DELAY, () => this.requestFire()); // wind up the reload bar for AI too
      return;
    }
    if (plan.action === 'buff') {
      // A self-buff applies to the bot itself — keep its current aim, just fire the utility.
      this.commitAim(botTank, botTank.getAimAngle(), Math.round(botTank.getPower()));
    }
    this.schedule(CGameController.BOT_FIRE_DELAY, () => this.requestFire()); // wind up the reload bar for AI too
  }

  // Ranging correction tuning.
  private static readonly RANGE_TARGET_TOL = 110; // "same target" if the aim point moved < this (px) — wide enough that a near-miss's kickback nudge doesn't reset the ranging
  private static readonly RANGE_HIT_TOL = 18; // a landing within this of the target counts as a hit
  private static readonly RANGE_BLOCKED_TOL = 120; // locked arc falling >this SHORT of the target = wall in the way → re-solve
  // Damped: the physics estimate (range ∝ power²) under-reads the true sensitivity at long range, so
  // gain 0.9 over-corrected ~1.7× and the shots oscillated. Half-stepping converges instead of ringing.
  private static readonly RANGE_GAIN = 0.5; // fraction of the physics-estimated correction to apply

  /**
   * Correct a shot's power from the LAST shot's observed landing (Ultra ranging). The solver is
   * drift-blind and returns the same power every turn, so a shot that overshoots would loop forever;
   * here the bot walks it in like a human — overshoot ⇒ less power, undershoot ⇒ more. The correction
   * is taken off the power ACTUALLY FIRED last turn (not the solver's fresh value), so it accumulates
   * and converges (Newton-style: range ∝ power², so dPower ≈ power/(2·range) · missAlongRange).
   */
  private ultraRangedAim(
    botTank: CTank,
    plan: {targetX: number; weaponIndex: number; angleDeg: number; power: number},
  ): {weaponIndex: number; angleDeg: number; power: number} {
    // Beams are hitscan STRAIGHT rays — never arced or ranged. Fire exactly as the planner aimed
    // (straight at the target, full power); reusing a ballistic record's angle would bend the ray.
    if (this.isBeamWeapon(plan.weaponIndex))
      return {weaponIndex: plan.weaponIndex, angleDeg: plan.angleDeg, power: plan.power};
    // A SELF-targeted round (the planner's clean-self / dig-blast: fired near-vertically at our OWN
    // column to clear the dirt burying us) isn't a ranged shot at an enemy. An enemy standing close by
    // would put a stale ranging record within RANGE_TARGET_TOL of our own x and bend the dig into a
    // sideways arc that never frees the tank — so fire it exactly as planned.
    if (Math.abs(plan.targetX - botTank.getPosition().x) < 1)
      return {weaponIndex: plan.weaponIndex, angleDeg: plan.angleDeg, power: plan.power};
    const rec = this.m_ultraShot.get(botTank);
    const sameTarget =
      rec && Math.abs(rec.targetX - plan.targetX) <= CGameController.RANGE_TARGET_TOL;

    // WALK IT IN: same target + a recorded landing → LOCK the angle we last fired and correct only the
    // POWER off the observed miss (overshoot ⇒ less, short ⇒ more). This is the empirical feedback the
    // solver can't do (it re-solves blind each turn and repeats its systematic error). We keep the angle
    // constant so the power↔range relation is consistent and converges — bestAim's own angle wobbles
    // turn to turn on rough terrain, which is why gating on it never corrected. BUT first VERIFY the
    // locked arc still reaches: if a wall has grown and it now falls way SHORT, drop to bestAim's fresh
    // pair (which arcs over it) instead of ploughing into the hill.
    if (rec && sameTarget && rec.landedX !== undefined) {
      const power = rangePowerCorrection({
        selfX: botTank.getPosition().x,
        targetX: plan.targetX,
        lastPower: rec.power,
        landedX: rec.landedX,
        hitTol: CGameController.RANGE_HIT_TOL,
        gain: CGameController.RANGE_GAIN,
      });
      const origin = botTank.muzzleForAngle(rec.angle);
      const field = {
        heightAt: (x: number) => this.m_land.getHeightAt(x),
        width: this.m_land.width,
        height: this.m_land.height,
      };
      const sim = simulateShot(
        origin,
        rec.angle,
        power,
        this.m_wind,
        field,
        {x: plan.targetX, y: origin.y},
        this.m_gustT + CGameController.BOT_FIRE_DELAY,
      );
      const dir = Math.sign(plan.targetX - botTank.getPosition().x) || 1;
      const shortfall = (plan.targetX - sim.hitX) * dir; // >0 = lands on the near side of the target
      if (shortfall < CGameController.RANGE_BLOCKED_TOL)
        // reaches (or overshoots — the correction fixes that)
        return {weaponIndex: plan.weaponIndex, angleDeg: rec.angle, power};
      // else the locked arc is blocked short → fall through to bestAim's fresh terrain-aware pair.
    }

    // FRESH pair (new target, changed terrain, or first shot): throw the real weapon with bestAim's own
    // matched (angle, power) — terrain- and gust-aware. Only a CAUTIOUS bot spends ONE Shell to measure a
    // true nuke on a genuinely fresh target, and never when all-in (scarce ammo).
    const cautious = this.ultraWeightsFor(botTank).premiumWaste >= 5000;
    const allIn = this.ultraFiniteOffense(this.economyFor(botTank)) <= 2;
    const measureFirst = !sameTarget && cautious && !allIn && this.isNukeWeapon(plan.weaponIndex);
    const wi = measureFirst ? getDefaultWeaponIndex() : plan.weaponIndex;
    return {weaponIndex: wi, angleDeg: plan.angleDeg, power: plan.power};
  }

  /** This Ultra bot's personality weights — drawn once per match from the seeded RNG (so it's stable
   *  for the bot and deterministic for network play), making two Ultra bots play divergent games. */
  private ultraWeightsFor(tank: CTank): UltraWeights {
    let w = this.m_ultraPersonality.get(tank);
    if (!w) {
      const name = ULTRA_PERSONALITY_NAMES[this.m_rng.int(ULTRA_PERSONALITY_NAMES.length)];
      w = ULTRA_PERSONALITIES[name];
      this.m_ultraPersonality.set(tank, w);
    }
    return w;
  }

  /** True if this Ultra bot lost life since the START of its previous turn — an enemy shelled it, so
   *  it now has our range. Updates the remembered life for next time. */
  private ultraTookDamageSinceLastTurn(tank: CTank): boolean {
    const life = tank.getHealth().nLife;
    const prev = this.m_ultraLastLife.get(tank);
    this.m_ultraLastLife.set(tank, life);
    return prev !== undefined && life < prev - 1;
  }

  /** Number of living enemy tanks within `radius` of a tank — the "am I surrounded?" gauge that gates
   *  buying a death (kamikaze) weapon. */
  private ultraEnemiesWithin(tank: CTank, radius: number): number {
    const p = tank.getPosition();
    return this.enemiesOf(tank).filter(t => t.distanceTo(p.x, p.y) <= radius).length;
  }

  /** Longest-range Move utility index (for an Ultra reposition/crate drive), or -1 if none exist. */
  private bestMoveWeaponIndex(): number {
    let best = -1,
      bestR = 0;
    for (const i of moveWeaponIndices()) {
      const r = this.moveRange(getWeapon(i));
      if (r > bestR) {
        bestR = r;
        best = i;
      }
    }
    return best;
  }

  // ── Reading the opposition ───────────────────────────────────────────────────────────────────────
  // Seconds of exposure a tank should assume when weighing whether to stand on fallout: roughly one
  // full lap of the turn order, since radiation DOT ticks in every in-battle state, not only on the
  // victim's own turn. Scaled by how many tanks are still taking turns.
  private static readonly ULTRA_SEC_PER_TURN = 5;
  private static readonly ULTRA_MAX_EXPOSURE = 45;
  // How many arsenal rows a player can actually SEE on the panel at once, and therefore the only
  // weapons an Ultra bot is allowed to know an opponent holds. Matches the HUD list geometry: the
  // strip is 70.8% of the 138px panel (≈97.7px) at 19.5px per `.wrow` — five rows, the rest scrolled
  // out of sight. Anything past those five is a surprise for the bot exactly as it is for the player.
  private static readonly ULTRA_VISIBLE_WEAPONS = 5;

  /** Life the fallout at column x would cost a tank parked there until it acts again. Mirrors the DOT
   *  updateTanks actually applies (strongest live zone × elapsed), so the estimate matches the bill. */
  private ultraRadiationCost(x: number): number {
    if (!GameConfig.radiationDamage || this.m_netMode) return 0; // fallout is cosmetic in both cases
    if (!this.m_land.radiationAt(Math.floor(x))) return 0;
    let dps = 0,
      remaining = 0;
    for (const z of this.m_land.getRadiationZones()) {
      if (z.damagePerSecond > dps) dps = z.damagePerSecond;
      if (z.timeRemaining > remaining) remaining = z.timeRemaining;
    }
    if (dps <= 0) return 0;
    const living = this.m_tanks.filter(t => t.isAlive()).length || 1;
    const exposure = Math.min(
      remaining,
      Math.min(CGameController.ULTRA_MAX_EXPOSURE, living * CGameController.ULTRA_SEC_PER_TURN),
    );
    return dps * exposure;
  }

  /**
   * What the OTHER side is holding and what they've been throwing. Weapons are visible in this game,
   * so an Ultra bot reads the enemy arsenal straight off their economy the way a human reads the depot
   * — that's what lets it answer a nuke build with beams and a self-burial instead of finding out the
   * hard way. The `fired*` tallies come from {@link ultraNoteEnemyShot}: capability is what they COULD
   * do, those are what they actually DO.
   */
  private ultraThreatAgainst(botTank: CTank): UltraThreat {
    const threat: UltraThreat = {...NO_THREAT};
    for (const foe of this.enemiesOf(botTank)) {
      if (foe.isSentry()) continue; // a turret carries no arsenal to read
      const econ = this.economyFor(foe);
      threat.credits = Math.max(threat.credits, econ.getCredits());
      // ONLY what the panel actually shows. The arsenal list is a scrolling strip and a human reading
      // an opponent's turn sees the first ULTRA_VISIBLE_WEAPONS rows of it — nothing further down.
      // Reading the whole inventory here would be the bot seeing through the UI, so the threat model
      // is built from exactly the same rows, in exactly the same order (staple first, then buy order).
      // A nuke bought sixth is genuinely a surprise, to the bot as much as to the player.
      for (const def of this.arsenalOf(foe).slice(0, CGameController.ULTRA_VISIBLE_WEAPONS)) {
        const i = def.index;
        const w = getWeapon(i);
        if (this.isNukeWeapon(i)) threat.hasNuke = true;
        if (this.isBeamWeapon(i)) threat.hasBeam = true;
        if (w.getEarth() > 0) threat.hasEarth = true;
        if (w.isCleaner()) threat.hasCleaner = true;
        const dmg = w.getDamage();
        if (dmg > threat.bigBlastDamage && !BOT_UTILITY_EXT.has(def.extType ?? 0))
          threat.bigBlastDamage = dmg;
      }
      // What they can bring NEXT turn, not just what's on the panel now: the credit readout is on the
      // same LCD as the arsenal, so a war chest deep enough for the cheapest nuke is public knowledge
      // and worth planning around. It raises the expected incoming blast (enough to make turtling a
      // candidate) but never sets `hasNuke` — that stays reserved for a round we can actually SEE,
      // because money is an intention and a bought nuke is a commitment.
      const affordable = this.cheapestNukeDamage(econ.getCredits());
      if (affordable > threat.bigBlastDamage) threat.bigBlastDamage = affordable;

      const seen = this.m_ultraEnemyFire.get(foe.getTeamId());
      if (seen) {
        threat.firedNukes += seen.nukes;
        threat.firedBeams += seen.beams;
        threat.firedEarth += seen.earth;
        threat.shotsSeen += seen.shots;
      }
    }
    return threat;
  }

  /** Damage of the heaviest nuke-class round `credits` could buy right now, or 0 if none is in reach. */
  private cheapestNukeDamage(credits: number): number {
    let best = 0;
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      const cost = WEAPON_DATABASE[i].cost ?? 0;
      if (cost <= 0 || cost > credits || !weaponEnabled(i) || !this.isNukeWeapon(i)) continue;
      best = Math.max(best, getWeapon(i).getDamage());
    }
    return best;
  }

  /** Log a round a tank actually fired, so its OPPONENTS can read intent and not just inventory. */
  private ultraNoteEnemyShot(shooter: CTank, weaponIndex: number): void {
    if (shooter.isSentry()) return;
    const team = shooter.getTeamId();
    let rec = this.m_ultraEnemyFire.get(team);
    if (!rec) {
      rec = {nukes: 0, beams: 0, earth: 0, shots: 0};
      this.m_ultraEnemyFire.set(team, rec);
    }
    rec.shots++;
    if (this.isNukeWeapon(weaponIndex)) rec.nukes++;
    if (this.isBeamWeapon(weaponIndex)) rec.beams++;
    if (getWeapon(weaponIndex).getEarth() > 0) rec.earth++;
  }

  /** The squad's shared kill target: the WEAKEST living enemy. Every squadmate derives it from the
   *  same public state, so they converge on one tank without passing notes — three half-dead enemies
   *  still shoot back, one dead one doesn't. Ties break on x so the pick is stable across clients. */
  private ultraFocusX(enemies: CTank[]): number | undefined {
    let best: CTank | null = null,
      bestHp = Infinity;
    for (const e of enemies) {
      const h = e.getHealth();
      const hp = h.nLife + h.nShield;
      if (hp < bestHp || (hp === bestHp && best && e.getPosition().x < best.getPosition().x)) {
        best = e;
        bestHp = hp;
      }
    }
    return best ? best.getPosition().x : undefined;
  }

  /** Is the battle effectively decided? Only then does a teammate who is beating us stop being a
   *  teammate (see the planner's `hostility`). Retaliation against one who shot US needs no endgame. */
  private ultraEndgame(botTank: CTank): boolean {
    if (this.enemiesOf(botTank).length <= 1) return true;
    if (this.m_gameType === EGameType.Rounds)
      return this.m_currentRound > this.m_totalRounds * 0.75;
    return false;
  }

  /** Gather the acting bot's world into the pure planner's input. */
  private buildUltraCtx(botTank: CTank, enemies: CTank[]): UltraCtx {
    const econ = this.economyFor(botTank);
    const pos = botTank.getPosition();
    const h = botTank.getHealth();

    // Owned weapons, pre-resolved to the fields the blast scorer needs (Explosion Size + resolution
    // folded into `radius`, so the planner compares true footprints).
    const weapons: UltraWeapon[] = [];
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      if (econ.getOwned(i) <= 0) continue;
      const w = getWeapon(i);
      const extNum = WEAPON_DATABASE[i].extType ?? 0;
      const rad = w.getRadiation();
      // Area reach from submunitions: a cluster's bomblets / an airburst's rain spread the damage
      // wide, so give those a bigger effective footprint (why Ultra favours them vs a spread group).
      const cluster = w.getClusterCount();
      let spread = cluster > 1 ? Math.min(160, Math.max(40, cluster * 15)) : 0;
      if (extNum === 13 /* AIRBURST */) spread = Math.max(spread, 120);
      weapons.push({
        index: i,
        ext: extNum,
        cost: WEAPON_DATABASE[i].cost ?? 0,
        count: econ.isUnlimited(i) ? Infinity : econ.getOwned(i),
        damage: w.getDamage(),
        radius: this.scaledBlastRadius(w),
        innerR: 0.5 * w.getSize(),
        spread,
        dotValue: rad.dmg * rad.time, // total damage-over-time this round lays down (gas / radioactive)
        earth: w.getEarth(),
        piercing: w.isRadioactive(),
        isBeam: isBeamExt(w.getExtType()),
        isCleaner: w.isCleaner(), // earth-remover (no damage) — digs the tank out when buried
        isMine: extNum === 16, // deploys a persistent mine on impact (area denial)
        // Reserve nukes and other pricey ordnance for high-value shots.
        isPremium:
          w.isNukeClass() ||
          (WEAPON_DATABASE[i].cost ?? 0) >= CGameController.ULTRA_PREMIUM_COST_VALUE,
        // Offensive = a damaging round the bot may fire AT a target (Shell + beams included; the
        // utility/self-buff/death/mine/move/tracer/jet types are not).
        // Airburst (ext 13) detonates at the ARC APEX, not on the ground — the planner aims ballistic,
        // so it can't place one correctly; keep it out of the firing pool rather than wasting it.
        offensive: w.getDamage() > 0 && !BOT_UTILITY_EXT.has(extNum) && extNum !== 13,
      });
    }

    // A buried tank can't drive (startDrive refuses), so it has NO move range this turn — it must dig
    // out (cleaner), beam, or heal instead.
    const buried = botTank.isBuried();
    let moveMaxDist = 0;
    if (!buried)
      for (const i of moveWeaponIndices())
        moveMaxDist = Math.max(moveMaxDist, this.moveRange(getWeapon(i)));

    return {
      self: {
        x: pos.x,
        y: pos.y,
        life: h.nLife,
        maxLife: botTank.getMaxLife(),
        shield: h.nShield,
        armor: h.nArmor,
        hazmat: h.nHazmat,
        credits: econ.getCredits(),
        onRadiation: this.m_land.radiationAt(Math.floor(pos.x)),
        buried,
        threatened: this.ultraTookDamageSinceLastTurn(botTank),
        score: this.tankScore(botTank),
      },
      enemies: enemies.map(e => {
        const c = e.getBodyCenter(); // aim at the collision CENTRE, not the hull top (beams grazed high)
        const eh = e.getHealth();
        return {
          x: c.x,
          y: c.y,
          life: eh.nLife,
          maxLife: e.getMaxLife(),
          shield: eh.nShield,
          hitRadius: e.getHitRadius(),
          buried: e.isBuried(),
        };
      }),
      weapons,
      crates: this.m_crates.map(c => ({x: c.x, kind: c.kind, amount: c.amount, landed: c.landed})),
      field: {
        heightAt: (x: number) => this.m_land.getHeightAt(x),
        width: this.m_land.width,
        height: this.m_land.height,
      },
      wind: this.m_wind,
      gustT0: this.m_gustT + CGameController.BOT_FIRE_DELAY,
      muzzleFor: (deg: number) => botTank.muzzleForAngle(deg),
      aimDegToward: (t: {x: number; y: number}) =>
        this.aimDegToward(botTank.getTurretPivot(), new Vec2(t.x, t.y)),
      moveMaxDist,
      radiationAt: (x: number) => this.m_land.radiationAt(Math.floor(x)),
      radiationCostAt: (x: number) => this.ultraRadiationCost(x),
      mines: this.m_mines.map(m => m.x), // known mines — the bot won't drive over one
      weights: this.ultraWeightsFor(botTank), // this bot's personality (ruthless / cautious / …)
      rnd: Math.random,
      // Our own squad: the planner prices splash on them as a cost, and tracks which of them have been
      // putting rounds into their own side (see m_friendlyDamage).
      allies: this.alliesOf(botTank).map((a): UltraAlly => {
        const c = a.getBodyCenter();
        const ah = a.getHealth();
        return {
          x: c.x,
          y: c.y,
          life: ah.nLife,
          maxLife: a.getMaxLife(),
          shield: ah.nShield,
          hitRadius: a.getHitRadius(),
          betrayal: this.m_friendlyDamage.get(a) ?? 0,
          score: this.tankScore(a),
        };
      }),
      threat: this.ultraThreatAgainst(botTank), // what the other side is holding / has been throwing
      focusX: this.ultraFocusX(enemies), // the squad's shared kill target (weakest enemy)
      endgame: this.ultraEndgame(botTank),
    };
  }

  // Weapon cost (credits) at/above which Ultra treats a round as premium ordnance to reserve.
  private static readonly ULTRA_PREMIUM_COST_VALUE = 1200; // only genuinely pricey ordnance is "premium"
  private static readonly ULTRA_NUKE_DAMAGE = 350; // damage at/above which a round counts as a NUKE (a.bomb+)
  // Ultra bots field a bigger war chest so they can actually AFFORD a nuke (real ones cost $4000-8000;
  // the 3000 default purse never stretches to one). The floor for an Ultra bot's starting credits.
  private static readonly ULTRA_START_CREDITS = 9000;

  // Computer-player difficulty (AI_LEVEL_MIN..AI_LEVEL_MAX; higher = sharper aim).
  getDifficulty(): number {
    return this.m_difficulty;
  }

  setDifficulty(level: number): void {
    this.m_difficulty = level;
  }

  // ── Settings pushed from the options menu (see ui/applySettings). Start-time
  // setters take effect on the next startGame; the rest are live. ──────────────
  /** Credits each player starts a match with (applied on the next startGame). */
  setStartCredits(n: number): void {
    this.m_startCredits = Math.max(0, Math.round(n));
  }

  /** How many of the next match's players are human (the first N teams); the rest are
   *  CPU. Read in `startGame`; the depot binds to tank 0 as before. */
  setHumanCount(n: number): void {
    this.m_humanCount = Math.max(0, Math.round(n));
  }

  /** Tanks each player fields (squad size, 1..5). Read in `startGame`. */
  setTanksPerTeam(n: number): void {
    this.m_tanksPerTeam = clamp(Math.round(n), 1, 5);
  }

  // ── Networked match ────────────────────────────────────────────────────────

  /**
   * Boot a network match: one human team per player (no local AI), a single tank
   * each, terrain seeded so every client is identical, and the lobby roster (same
   * order on all clients) for names/colours. The server is the turn arbiter, so
   * `onTurnEnd` fires when the local player's turn resolves (the client then reports
   * its authoritative outcome and waits for the next `turnBegin`).
   */
  startNetworkGame(opts: {
    seed: number;
    players: number;
    localIndex: number;
    roster: {name: string; color: string}[];
    /** Host wind strength: 0 = calm, 1 = normal, 2 = strong. */
    wind: number;
    /** Host map width in viewport-widths (1..5). */
    mapSize: number;
    /** War length — number of battles (Deathmatch); 1 for Rounds/Points. */
    battles: number;
    /** Tanks each player commands (1..4) — the shared squad size. */
    tanksPerTeam: number;
    /** Which battle this boot is (1-based) — >1 when replayed to a reconnect mid-war. */
    currentBattle: number;
    /** The HOST's logical view size — the shared world resolution every client builds at. */
    viewW: number;
    viewH: number;
    /** The HOST's gameplay config — applied identically on every client (determinism). */
    config: MatchConfig;
    onTurnEnd?: () => void;
    onCommand?: (cmd: GameCommand) => void;
  }): void {
    this.m_netMode = true;
    this.m_netLocalIndex = opts.localIndex;
    this.m_terrainSeed = opts.seed >>> 0 || 1;
    this.m_currentBattle = Math.max(1, Math.round(opts.currentBattle)); // 1 fresh; >1 on reconnect
    this.setTotalBattles(opts.battles); // shared war length (server drives per-battle advance)
    this.m_netRoster = opts.roster;
    this.m_onNetTurnEnd = opts.onTurnEnd ?? null;
    this.m_onNetCommand = opts.onCommand ?? null;
    this.m_landMode = -1; // shape is random-from-seed (deterministic), not a local override
    this.m_netLandScale = clamp(Math.round(opts.mapSize), 1, 5); // shared world width
    // The HOST's view size is the shared logical resolution; startGame applies it so every
    // client builds the same-length heightmap. The host renders it 1:1; others stretch it.
    this.m_netViewW = clamp(Math.round(opts.viewW), 320, 4096);
    this.m_netViewH = clamp(Math.round(opts.viewH), 240, 4096);

    // A network match is authoritative and IDENTICAL on every client, so it ignores all
    // local dev/URL switches a player may have set (?flatland, ?weapontest, ?weaponsel,
    // ?skiptexture, demo). Left on, they'd desync clients — e.g. one flat surface vs one
    // seeded terrain, which corrupts the shared heightmap sync.
    this.m_flatLand = false; // ?flatland
    this.setWeaponTest(false); // ?weapontest (also clears economy free-fire)
    this.m_currentWeaponIndex = getDefaultWeaponIndex(); // ?weaponsel selection
    GameConfig.demo = false; // demo/attract mode
    CLand.debugMaterials = false; // ?skiptexture
    this.m_speedScale = 1; // game speed must match across clients (fixed-step determinism)
    // Wind is host-chosen and must be identical + deterministic on every client. Force the
    // shared strength, a constant per-game wind (seeded, so no local Change-Wind mode drifts
    // it), and the Linear model (Realistic gusts breathe over wall-clock time — a desync risk).
    this.m_windScale = clamp(Math.round(opts.wind), 0, 2);
    GameConfig.changeWind = 0; // Per-game: wind set once from the seed, constant all match
    GameConfig.windModel = 0; // Linear (uniform) — no time-based gusts
    // Adopt the HOST's gameplay config so every client runs the SAME simulation. Any of these
    // read from a client's OWN Settings instead would diverge the world: the scalars change
    // trajectories/blast/damage/recoil, gameType changes the damage model, buryTanks/relative-
    // Turrets change resting position / firing angle. The host is the single source of truth.
    const c = opts.config;
    GameConfig.hitpoints = c.hitpoints;
    GameConfig.tankSizeScale = c.tankSizeScale;
    GameConfig.explosionScale = c.explosionScale;
    GameConfig.powerScale = c.powerScale;
    GameConfig.kickbackScale = c.kickbackScale;
    GameConfig.buryTanks = c.buryTanks;
    this.m_variance = c.variance; // per-shot inaccuracy gates a seeded draw — must match on all
    GameConfig.relativeTurrets = c.relativeTurrets;
    GameConfig.utilityTurn = c.utilityTurn;
    // Spawn scatter decides where every tank stands — it MUST come from the host. Unlike Randomize
    // Turns it is net-safe to run: spawnSlots draws from the seeded match RNG, not Math.random.
    GameConfig.randomizePosition = c.randomizePosition;
    GameConfig.roundTime = c.roundTime; // host owns the shot clock so every client forfeits on the same limit
    GameConfig.crateChance = c.crateChance;
    GameConfig.radiationDamage = c.radiationDamage; // fallout DOT rule — host is source of truth
    // Randomize Turns is FORCED OFF in net: the server owns the turn order, and the local
    // shuffle uses Math.random() AND reorders the tank array — which would break the
    // index-based turn hand-off and snapshot mapping. (Also guarded at the call sites.)
    GameConfig.randomizeTurns = false;
    this.m_startCredits = c.startCredits;
    this.m_gameType = c.gameType === EGameType.Rounds ? EGameType.Rounds : EGameType.Deathmatch;
    // Economy rates must match on every client — buys are relayed and earning runs in each
    // client's sim, so a rate mismatch would diverge the (now fully deterministic) credit totals.
    this.setSellRate(c.sellRate);
    this.m_creditDamage = c.creditDamage;
    this.m_creditKill = c.creditKill;
    this.m_creditTurn = c.creditTurn;
    this.m_creditRound = c.creditRound;
    // Real economy in network: clear any leftover free-fire (dev weapon-test) so each player
    // spends its own credits + inventory. The acting client charges ammo from its own economy
    // (see fire()); spectators only simulate the relayed weapon, so no inventory sync is needed —
    // credits ride the per-turn snapshot. setFreeFire is NOT cleared by reset(), hence explicit.
    this.m_economy.setFreeFire(false);

    this.setHumanCount(opts.players); // every team human → no local bots
    // Squad size: each player commands `tanksPerTeam` tanks. m_netTanksPerTeam maps the active
    // TANK index (the server's turn cursor) back to its owning player for the local-turn check.
    this.m_netTanksPerTeam = clamp(Math.round(opts.tanksPerTeam), 1, 4);
    this.setTanksPerTeam(this.m_netTanksPerTeam);
    this.m_bootingNet = true; // keep the net config through startGame's reset
    this.startGame(opts.players);
    this.m_bootingNet = false;
  }

  /** The fixed LOGICAL view/world size (px). The sim, camera, terrain and physics all work
   *  in these coordinates; the compositor stretches the logical scene to the live display.
   *  Height is a shared design constant (consistent element sizes); solo width follows the
   *  display aspect, net width is a shared constant. Fixed after startGame (a window resize
   *  only re-fits the GPU present, never rebuilds the world). */
  getViewWidth(): number {
    return this.m_viewW;
  }
  getViewHeight(): number {
    return this.m_viewH;
  }

  /** Snapshot THIS host's gameplay settings as the shared MatchConfig (sent at Start so every
   *  client adopts them — see startNetworkGame). Reads live GameConfig + match fields. */
  getMatchConfig(): MatchConfig {
    return {
      hitpoints: GameConfig.hitpoints,
      tankSizeScale: GameConfig.tankSizeScale,
      explosionScale: GameConfig.explosionScale,
      powerScale: GameConfig.powerScale,
      kickbackScale: GameConfig.kickbackScale,
      buryTanks: GameConfig.buryTanks,
      variance: this.m_variance,
      relativeTurrets: GameConfig.relativeTurrets,
      utilityTurn: GameConfig.utilityTurn,
      randomizePosition: GameConfig.randomizePosition,
      roundTime: GameConfig.roundTime,
      crateChance: GameConfig.crateChance,
      radiationDamage: GameConfig.radiationDamage,
      startCredits: this.m_startCredits,
      gameType: this.m_gameType,
      sellRate: this.m_sellRate,
      creditDamage: this.m_creditDamage,
      creditKill: this.m_creditKill,
      creditTurn: this.m_creditTurn,
      creditRound: this.m_creditRound,
    };
  }

  /** The live NATIVE display size (container px). main keeps this current on every resize; a
   *  solo match reads its ASPECT at start to derive its logical world width (height is the
   *  fixed design constant). Does NOT resize a match in progress — only the next startGame. */
  setDisplaySize(w: number, h: number): void {
    this.m_displayW = Math.max(1, Math.round(w));
    this.m_displayH = Math.max(1, Math.round(h));
  }

  /** The live native display size — what a host publishes as the shared world resolution. */
  getDisplayWidth(): number {
    return this.m_displayW;
  }
  getDisplayHeight(): number {
    return this.m_displayH;
  }

  /** Monotonic turn counter (bumped each beginTurn). A held HUD aim drag captures it on grab and stops
   *  applying once it changes — so a pointer held across a turn hand-off can't aim the next player. */
  turnSeq(): number {
    return this.m_turnSeq;
  }

  /** True while it is the local player's turn in a network match (drives input/HUD). */
  isLocalNetTurn(): boolean {
    // The active TANK (m_currentPlayerIndex is a tank index) is mine when its owning player —
    // contiguous squads: owner = floor(tankIdx / tanksPerTeam) — is my local player index.
    return (
      this.m_netMode &&
      Math.floor(this.m_currentPlayerIndex / this.m_netTanksPerTeam) === this.m_netLocalIndex
    );
  }

  /** True when this client is a mid-match SPECTATOR: online, but not in the turn order (local index
   *  below 0). Such a client watches the deterministic sim and never owns a turn. */
  isNetSpectator(): boolean {
    return this.m_netMode && this.m_netLocalIndex < 0;
  }

  /** Whether THIS client should upload the match stats: always in a solo game, but in a net match
   *  only the first player in the turn order (localIndex 0) — so N clients don't each count the same
   *  game (spectators are localIndex < 0 and never upload). */
  isStatsUploader(): boolean {
    return !this.m_netMode || this.m_netLocalIndex === 0;
  }

  /** The match tallies as they stand right now — the running total the drain differences against.
   *  damageDealt is summed from the tanks' cumulative net damage; the rest are live per-match
   *  counters, and `sec` is the whole war's elapsed play time (m_time is monotonic). */
  private statsSnapshot(): MatchStatTally {
    const damageDealt = this.m_tanks.reduce((sum, t) => sum + Math.max(0, t.getDamageDealt()), 0);
    return {
      weaponsFired: this.m_stats.weaponsFired,
      shotsFired: this.m_stats.shotsFired,
      tanksDestroyed: this.m_stats.tanksDestroyed,
      damageDealt: Math.round(damageDealt),
      nukesFired: this.m_stats.nukesFired,
      terrainCarved: this.m_stats.terrainCarved,
      creditsSpent: this.m_stats.creditsSpent,
      sec: Math.max(0, Math.round(this.m_time - this.m_matchStartTime)),
    };
  }

  /** Drain everything played since the last drain into an upload-ready delta, stamped with the
   *  progress `closed` by this flush. Incremental by design: the uploader banks each battle as it
   *  ends, so a quit / a closed tab / a lost connection only ever risks the battle in play (the old
   *  one-lump-at-the-end upload lost the entire match). Every field is a difference against the
   *  previous drain and floored at 0, so a between-battle respawn (tank damage resets) can never
   *  produce a negative. Safe to call from any client — a non-uploader simply discards the result. */
  takeStatsDelta(closed: StatsFlush = {}): StatsDelta {
    const cur = this.statsSnapshot();
    const base = this.m_statsBase;
    const since = (k: Exclude<keyof MatchStatTally, 'sec'>): number =>
      Math.max(0, cur[k] - base[k]);
    this.m_statsBase = cur;
    return {
      wars: closed.warOver ? 1 : 0,
      battles: Math.max(0, Math.round(closed.battles ?? 0)),
      weaponsFired: since('weaponsFired'),
      shotsFired: since('shotsFired'),
      tanksDestroyed: since('tanksDestroyed'),
      damageDealt: since('damageDealt'),
      nukesFired: since('nukesFired'),
      terrainCarved: since('terrainCarved'),
      creditsSpent: since('creditsSpent'),
      playSec: Math.max(0, cur.sec - base.sec),
      warSec: closed.warOver ? cur.sec : 0, // "longest war" spans every battle, not just this flush
      online: this.m_netMode,
    };
  }

  /** True while a turn's action is still resolving (shot in flight / settling) OR while the
   *  battle-winner celebration plays between Deathmatch battles. The net bridge queues the
   *  server's next turn hand-off until this clears (so it can't interrupt a shot or an
   *  intermission). */
  isNetSimBusy(): boolean {
    return this.m_netShotResolving || (this.m_netMode && this.m_gameState === EGameState.BattleEnd);
  }

  /** True while a net match is running (used to guard a deferred between-battle advance). */
  isNetBattleActive(): boolean {
    return this.m_netMode;
  }

  /** The acting client's read on whether this shot ended the battle (≤ 1 team left). */
  isNetBattleOver(): boolean {
    return this.m_netMode && this.livingTeamCount() <= 1;
  }

  /** Server-driven turn hand-off (a turnBegin that follows a shot): the once-per-turn effects that
   *  the local endTurn can't own in net (it may fire repeatedly). Deterministic across clients —
   *  every client is at the same settled sim state + shares the seeded RNG cursor and rates. */
  netTurnHandoff(): void {
    if (!this.m_netMode) return;
    this.awardSurvivorCredit(this.m_creditTurn); // per-turn income (synced rate)
  }

  /** Server-signalled: a full round just completed → pay per-round survivor income + roll the Crates
   *  chance ONCE per round (not per turn). Deterministic (same survivors + synced rate + shared
   *  seeded RNG cursor on every client), applied on the turnBegin that wraps. */
  netAwardRoundCredit(): void {
    if (!this.m_netMode) return;
    this.awardSurvivorCredit(this.m_creditRound);
    this.maybeSpawnCrate(); // seeded → identical crate (or none) on every client, once per round
  }

  /** Show the battle-winner celebration (standings if the war is over). Idempotent — a second
   *  call while already celebrating is a no-op, so the local trigger and the server's gameOver
   *  don't double up. */
  netFinishBattle(): void {
    if (this.m_netMode && this.m_gameState !== EGameState.BattleEnd) this.finishBattle();
  }

  /** Server-driven: a Deathmatch battle ended and the war continues. Regenerate the terrain
   *  from the shared `seed` and respawn everyone (war stats + credits carry over), starting the
   *  fresh battle. Called after the intermission (see NetGame). */
  netNextBattle(seed: number): void {
    if (!this.m_netMode) return;
    this.m_terrainSeed = seed >>> 0 || 1;
    // Reseed the gameplay RNG from the new terrain seed (same derivation as startGame) so every
    // client's new battle — spawn jitter, wind, crates — is identical regardless of prior cursor.
    this.m_rng.seed(((this.m_terrainSeed ?? Date.now()) ^ 0x9e3779b9) >>> 0);
    this.nextBattle();
  }

  /**
   * A 32-bit FNV-1a hash of the deterministic simulation state — tank positions/health,
   * the terrain heightmap, and the gameplay RNG cursor. In lockstep every client must
   * agree on this after each turn; a mismatch is a desync signal (→ request a keyframe).
   */
  stateHash(): number {
    let h = 0x811c9dc5 >>> 0;
    const mix = (v: number): void => {
      h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
    };
    for (const t of this.m_tanks) {
      const p = t.getPosition();
      const hp = t.getHealth();
      mix(Math.round(p.x));
      mix(Math.round(p.y));
      mix(hp.nLife | 0);
      mix(hp.nShield | 0);
      mix(hp.nArmor | 0);
      mix(hp.nHazmat | 0);
      mix(t.isAlive() ? 1 : 0);
    }
    const heights = this.m_land.getHeights();
    for (let i = 0; i < heights.length; i++) mix(heights[i]);
    // Mines: deploy order is deterministic (relayed fire → same order on every client), so hashing
    // them in array order detects a mine that drifted, armed, or detonated on one client but not
    // another (position + armed-state + weapon + count). Owner is attribution-only, not hashed.
    for (const m of this.m_mines) {
      mix(Math.round(m.x));
      mix(Math.round(m.y));
      mix(m.armed > 0 ? 1 : 0);
      mix(m.weaponIndex);
    }
    mix(this.m_mines.length);
    // Crates are deliberately NOT hashed. Their physics (updateCrates) free-runs every frame on the
    // wall-clock fixed-step count OUTSIDE the lockstep shot window — during the aim/watch phase, which
    // isn't step-synchronised across clients — so an airborne crate is a latency-worth of descent steps
    // ahead on one client vs another. A landed crate settles deterministically, but a mid-descent one
    // would diverge a few px and flip this FNV hash, false-flagging an honest spectator. Crates are
    // authoritative-by-adoption instead: pinned from every keyframe (see NetGame.reconcileKeyframe →
    // reconcileNetCrates) rather than self-simulated-and-compared.
    mix(this.m_rng.getState());
    return h >>> 0;
  }

  /** Server turn hand-off: make `idx` the active player and begin its turn. */
  netSetActivePlayer(idx: number): void {
    if (!this.m_netMode || this.m_tanks.length === 0) return;
    this.m_currentPlayerIndex = clamp(Math.round(idx), 0, this.m_tanks.length - 1);
    this.beginTurn();
  }

  /** Authoritative post-turn state the acting client broadcasts (tanks + terrain + wind). */
  getNetSnapshot(): NetSnapshot {
    const tanks = this.m_tanks.map(t => {
      const h = t.getHealth();
      const p = t.getPosition();
      return {
        x: p.x,
        y: p.y,
        life: h.nLife,
        shield: h.nShield,
        armor: h.nArmor,
        hazmat: h.nHazmat,
        credits: t.getCredits(),
        alive: t.isAlive(),
      };
    });
    return {
      tanks,
      heights: Array.from(this.m_land.getHeights()),
      wind: {x: this.m_wind.x, y: this.m_wind.y},
      rngState: this.m_rng.getState(), // capture the cursor so a bootstrap restores it exactly
      // Owner as an INDEX (a CTank ref can't cross the wire); -1 = ownerless (an unattributed mine).
      mines: this.m_mines.map(m => ({
        x: m.x,
        y: m.y,
        armed: m.armed,
        weaponIndex: m.weaponIndex,
        ownerIdx: m.owner ? this.m_tanks.indexOf(m.owner) : -1,
      })),
      // Supply crates — authoritative so a reconnecting/keyframe client reproduces a crate already on
      // the field (else it'd miss the drop, then diverge when a health crate is picked up). id/phase
      // are cosmetic (local wobble/tracking) — regenerated on adopt.
      crates: this.m_crates.map(c => ({
        x: c.x,
        y: c.y,
        vy: c.vy,
        kind: c.kind,
        amount: c.amount,
        weaponIndex: c.weaponIndex,
        landed: c.landed,
      })),
    };
  }

  /**
   * Fly a draw-only "ghost" projectile from the acting tank so a spectator sees the
   * opponent's shot arc. Reads the current aim (set by the relayed `aim` command). It
   * never carves or damages — the authoritative snapshot delivers the real outcome.
   */
  netSpawnGhost(): void {
    if (!this.m_netMode) return;
    const tank = this.getCurrentTank();
    if (!tank?.isAlive()) return;
    const weapon = getWeapon(this.m_currentWeaponIndex);
    const ext = weapon.getExtType();
    if (isBeamExt(ext) || ext === EXT.MOVE || ext === EXT.JET) return; // no ballistic arc
    const g = new CShot();
    g.initFromTank(tank.getMuzzlePosition(), tank.firingAngle(), this.m_power, 0, 0, tank);
    g.setWeaponIndex(this.m_currentWeaponIndex);
    this.m_ghostShots.push(g);
    this.markDirty();
  }

  /** Number of in-flight spectator ghost arcs (0 outside a network match). */
  getGhostShotCount(): number {
    return this.m_ghostShots.length;
  }

  /** Step spectator ghost projectiles; drop them on impact / off-world. */
  private updateGhostShots(dt: number): void {
    if (!this.m_ghostShots.length) return;
    this.m_ghostShots = this.m_ghostShots.filter(g => {
      g.update(dt, this.m_effWind, this.m_windGroundAt);
      const p = g.getPosition();
      if (g.isDead()) return false;
      if (p.x < -50 || p.x > this.m_worldWidth + 50 || p.y > this.m_viewH + 50) return false;
      return p.y < this.m_land.getHeightAt(p.x); // still above ground
    });
    this.markDirty();
  }

  /** Apply an authoritative snapshot from the acting client (spectator side). */
  applyNetSnapshot(s: NetSnapshot): void {
    if (!s || !Array.isArray(s.tanks)) return; // defend against a malformed snapshot (see NET validation)
    this.m_ghostShots = []; // the shot resolved — clear any in-flight visual arc
    s.tanks.forEach((st, i) => {
      if (st && typeof st === 'object') this.m_tanks[i]?.setNetState(st);
    });
    // Reconcile terrain so remote craters/deposits render (not just collision heights).
    if (s.heights.length) this.m_land.setHeightmap(s.heights);
    this.m_wind.x = s.wind.x;
    this.m_wind.y = s.wind.y;
    // Restore the seeded-RNG cursor so this client resumes IN PHASE with the room: the state hash
    // mixes the cursor and shots draw from it, so a bootstrap that skipped this ran a fraction out of
    // phase — desyncing its next shot and false-flagging a divergence. (Older snapshots without the
    // field leave the cursor untouched.) See {@link NetSnapshot.rngState}.
    if (typeof s.rngState === 'number') this.m_rng.setState(s.rngState);
    // Reproduce deployed mines (position, arm countdown, owner-by-index). Absent on older snapshots →
    // leave the local mines untouched. vy resets to 0 (settleMines re-derives it from the terrain).
    if (Array.isArray(s.mines)) {
      this.m_mines = s.mines.map(m => ({
        x: m.x,
        y: m.y,
        vy: 0,
        armed: m.armed,
        weaponIndex: m.weaponIndex,
        owner: m.ownerIdx >= 0 ? (this.m_tanks[m.ownerIdx] ?? null) : null,
      }));
    }
    this.reconcileNetCrates(s); // pin supply crates from the authoritative snapshot
    this.markDirty();
  }

  /**
   * Adopt the supply crates from an authoritative snapshot (fresh local id + wobble phase — those are
   * cosmetic/tracking only). Unlike the rest of `applyNetSnapshot`, this runs on EVERY keyframe, not
   * just bootstrap: crate physics free-runs on the wall-clock fixed-step count outside the lockstep
   * shot window, so a spectator's crates drift from the actor's and are excluded from `stateHash`.
   * Pinning them here keeps the field correct (a health-crate pickup still lands) without the drift
   * false-flagging divergence. Absent on older snapshots → leave the local crates untouched.
   */
  reconcileNetCrates(s: NetSnapshot): void {
    if (!Array.isArray(s.crates)) return;
    this.m_crates = s.crates.map(c => ({
      x: c.x,
      y: c.y,
      vy: c.vy,
      kind: c.kind as CrateKind, // one of the 4 kinds (server-validated); an unknown kind is inert on pickup
      amount: c.amount,
      weaponIndex: c.weaponIndex,
      landed: c.landed,
      phase: 0,
      id: ++this.m_crateSeq,
    }));
  }

  /** Depot sell-back refund fraction (0..1), live. */
  setSellRate(fraction: number): void {
    this.m_sellRate = fraction;
    this.m_economy.setSellRate(fraction);
  }

  /** Number of battles in the match (feeds "Battle X of Y"). */
  setTotalBattles(n: number): void {
    this.m_totalBattles = Math.max(1, Math.round(n));
  }

  /** Number of rounds in a Point/Rounds game (Play → Rounds). */
  setTotalRounds(n: number): void {
    this.m_totalRounds = Math.max(1, Math.round(n));
  }

  /** Forced landscape shape 0..4, or -1 for a random landscape (next startGame). */
  setLandMode(mode: number): void {
    this.m_landMode = mode;
  }

  /** DEV (`?flatland=1`): force a perfectly flat test surface on the next startGame. */
  setFlatLand(on: boolean): void {
    this.m_flatLand = on;
  }

  /** Wind-strength scalar (0 = disabled). Live for drift; reseeds next game. */
  setWindScale(scale: number): void {
    this.m_windScale = Math.max(0, scale);
  }

  /** Per-shot variance (inaccuracy) on/off, live. */
  setVariance(on: boolean): void {
    this.m_variance = on;
  }

  /** Credits earned per point of life removed (Economy → Credit Damage), live. */
  setCreditDamage(n: number): void {
    this.m_creditDamage = Math.max(0, n);
  }

  /** Credits earned per kill (Economy → Credit Kill), live. */
  setCreditKill(n: number): void {
    this.m_creditKill = Math.max(0, n);
  }

  /** Credits each survivor earns per turn (Economy → Credit Turn), live. */
  setCreditTurn(n: number): void {
    this.m_creditTurn = Math.max(0, n);
  }

  /** Credits each survivor earns per round (Economy → Credit Round), live. */
  setCreditRound(n: number): void {
    this.m_creditRound = Math.max(0, n);
  }

  /** Match type — kill credit is only paid in Deathmatch. */
  setGameType(t: EGameType): void {
    this.m_gameType = t;
  }

  /** Game-speed multiplier (1 = normal), live. */
  setGameSpeed(scale: number): void {
    this.m_speedScale = Math.max(0.1, scale);
  }

  // ========================================================================
  // WIND & PHYSICS
  // ========================================================================

  private static readonly MAX_WIND = 5;
  // Bot "thinking" delay between deciding a shot and firing it (seconds). The gust clock advances
  // over this window, so the aim solver predicts the gust at (now + this) to match the launch.
  private static readonly BOT_FIRE_DELAY = 0.8;
  // The vertical wind is 1/3 the horizontal max (matching the original's maxY = maxX·0.3333).
  private static readonly WIND_Y_RATIO = 1 / 3;

  /** Seed a fresh random wind at the start of a game (scaled by Settings → Wind). */
  private updateWind(): void {
    const max = CGameController.MAX_WIND * this.m_windScale;
    this.m_wind = new Vec2(
      this.m_rng.plusMinus(max),
      this.m_rng.plusMinus(max * CGameController.WIND_Y_RATIO),
    );
    this.m_windTimer = 0;
  }

  /**
   * Recompute `m_effWind` — the wind the physics actually feels this frame. Linear mode: exactly the
   * sustained `m_wind`. Realistic mode: fold in GUSTS — a smooth multi-frequency envelope that makes
   * the wind breathe (calm days gust little, strong winds gust hard, since it scales with |m_wind|).
   * Gusts are multiplicative so a Disabled wind (0) stays dead calm. This flows into every wind-driven
   * system at once (shots, smoke, weather, crates, fireworks) because they all read `m_effWind`.
   */
  private updateEffectiveWind(dt: number): void {
    this.m_gustT += dt;
    // Realistic: fold the shared gust envelope (core/wind.ts) onto the sustained wind — the same
    // function the aim AI predicts, so bot shots and real shots feel identical wind. Linear: the
    // factor is a flat {1,1}, so m_effWind == m_wind (no gusts).
    const g = gustFactor(this.m_gustT);
    this.m_effWind = new Vec2(this.m_wind.x * g.x, this.m_wind.y * g.y);
  }

  /**
   * Drift the wind vector slowly and re-randomise its acceleration on a timer.
   * Called every frame.
   */
  private updateWindDrift(dt: number): void {
    const MAX = CGameController.MAX_WIND * this.m_windScale; // 0 when wind is Disabled
    const maxY = MAX * CGameController.WIND_Y_RATIO;
    this.m_wind.x = clamp(this.m_wind.x + this.m_windAccel.x * dt, -MAX, MAX);
    this.m_wind.y = clamp(this.m_wind.y + this.m_windAccel.y * dt, -maxY, maxY);

    this.m_windTimer -= dt;
    if (this.m_windTimer <= 0) {
      this.m_windTimer = this.m_rng.float() * 8 + 4; // 4..12 s until next drift target
      this.m_windAccel = new Vec2(this.m_rng.plusMinus(2), this.m_rng.plusMinus(1));
    }
  }

  // ========================================================================
  // UI CONTROL HANDLERS
  // ========================================================================

  setAngle(angle: number): void {
    if (this.m_paused) return;
    this.markDirty();
    this.m_angle = angle;
    const tank = this.getCurrentTank();
    // Persist the aim on the acting tank so it survives the turn cycle.
    tank.setAimAngle(angle);

    if (tank.isHuman()) {
      tank.setTurretAngle(this.m_angle);
    }
    if (this.m_netMode && this.isLocalNetTurn()) this.m_netAimDirty = true;
  }

  setPower(power: number): void {
    if (this.m_paused) return;
    this.markDirty();
    this.m_power = power;
    // Persist the power on the acting tank so it survives the turn cycle.
    this.getCurrentTank().setPower(power);
    if (this.m_netMode && this.isLocalNetTurn()) this.m_netAimDirty = true;
  }

  /** Stream the local player's live aim to spectators, throttled per NET_AIM_INTERVAL so a drag
   *  can't flood the socket. Cosmetic only — fire() re-sends the FINAL aim before the shot, so the
   *  deterministic outcome never depends on these. Called each frame while a battle turn is live. */
  private relayLiveAim(): void {
    if (!this.m_netMode || !this.isLocalNetTurn() || !this.m_netAimDirty) return;
    if (this.m_time - this.m_lastAimSentTime < NET_AIM_INTERVAL) return;
    this.m_netAimDirty = false;
    this.m_lastAimSentTime = this.m_time;
    this.m_onNetCommand?.({t: 'aim', angle: this.m_angle, power: this.m_power});
  }

  /**
   * Restore the current tank's power AND angle to its last real shot — the "↺"
   * panel button. Tooltip: "Use the reset button to set power and angle to your
   * last shot." (The last-shot fields are seeded to the starting aim before the
   * first shot.)
   */
  resetAim(): void {
    if (this.m_paused) return;
    const tank = this.getCurrentTank();
    this.setAngle(tank.getLastShotAngle());
    this.setPower(tank.getLastShotPower());
  }

  selectWeapon(index: number): void {
    if (this.m_paused) return;
    this.cancelMovePlacing(); // changing weapon disarms any pending Move placement
    this.markDirty();
    if (index >= 0 && index < WEAPON_DATABASE.length) {
      this.m_currentWeaponIndex = index;
      // Persist the choice on the acting tank so it survives the turn cycle — and, with Weapon
      // Persistence on, on the rest of its squad too (see setSquadWeapon).
      const tank = this.m_tanks[this.m_currentPlayerIndex];
      if (tank) this.setSquadWeapon(tank, index);
    }
  }

  /** Dev (?weaponsel=<id>): grant weapon <id> unlimited ammo and select it on every
   *  tank so it stays picked across the turn cycle (pairs with ?weapontest=1). */
  forceWeapon(index: number): void {
    if (index < 0 || index >= WEAPON_DATABASE.length) return;
    this.m_economy.setUnlimited(index);
    this.m_currentWeaponIndex = index;
    for (const t of this.m_tanks) t.setWeaponIndex(index);
    this.markDirty();
  }

  // --- HUD accessors ---------------------------------------------------------
  getWeaponDefs() {
    // The control-weapon lock only restricts the HUMAN's own list. During a bot's
    // turn (or normal play) the full arsenal is shown, so the HUD reflects the
    // weapon the active player is actually using rather than the locked one.
    const ci = controlWeaponIndex();
    if (ci >= 0 && this.isPlayerTurn()) return [WEAPON_DATABASE[ci]];
    // Hide weapons disabled in Game Content; the staple (Shell) is always available.
    const staple = getDefaultWeaponIndex();
    const enabled = (i: number) => i === staple || weaponEnabled(i);
    // No active tank yet (arsenal preview before a match / on a menu) → there's no inventory to
    // read, so show the enabled arsenal (what could be bought).
    const tank = this.getCurrentTank();
    if (!tank) return WEAPON_DATABASE.filter(w => enabled(w.index));
    // Otherwise the ACTIVE player's own arsenal — only what THEY have in stock — whether that's the
    // local human, a bot, or a remote player (every client mirrors each player's economy via relayed
    // buys, and bots buy through their own economy). So a spectator watching someone else's turn sees
    // the acting player's real inventory (e.g. a Shell-only bot shows only Shell), not the whole
    // arsenal.
    return this.arsenalOf(tank);
  }

  /**
   * A tank's arsenal in the order the HUD lists it: the unlimited STAPLE (Shell) first, then bought
   * weapons in BUY order ("2." = the first weapon you bought, "3." the next, …), so the row numbers
   * track acquisition rather than a fixed database id. Weapons disabled in Game Content are hidden;
   * the staple always qualifies, free-fire puts everything in stock, and the tank's chosen weapon is
   * by definition in its stock so it always appears.
   */
  private arsenalOf(tank: CTank): WeaponDef[] {
    const staple = getDefaultWeaponIndex();
    const enabled = (i: number) => i === staple || weaponEnabled(i);
    const econ = this.economyFor(tank);
    const owned = WEAPON_DATABASE.filter(w => enabled(w.index) && econ.hasStock(w.index));
    const order = econ.getAcquireOrder();
    const rank = (i: number): number => {
      const r = order.indexOf(i);
      // staples (not bought, r<0) FIRST, in database order; then bought weapons in buy order after.
      return r >= 0 ? WEAPON_DATABASE.length + r : i;
    };
    return owned.sort((a, b) => rank(a.index) - rank(b.index));
  }

  getCurrentWeaponIndex(): number {
    return this.m_currentWeaponIndex;
  }

  getCurrentWeapon(): CWeapon {
    return getWeapon(this.m_currentWeaponIndex);
  }

  // --- Weapons Depot / economy ----------------------------------------------
  // All depot reads/writes go through the ACTIVE player's economy: solo that's the human's
  // shared depot; net it's the current player's own per-tank economy (so a relayed buy applies
  // to the buyer on every client). buy/sell/autobuy relay on the local turn so peers mirror them.
  getCredits(): number {
    return this.activeEconomy().getCredits();
  }

  getMapName(): string {
    return this.m_mapName;
  }

  /** Per-weapon owned rounds (Infinity = unlimited staple). */
  getOwnedCounts(): number[] {
    return this.activeEconomy().ownedSnapshot();
  }

  isUnlimitedWeapon(i: number): boolean {
    return this.activeEconomy().isUnlimited(i);
  }

  buyWeapon(i: number): boolean {
    const ok = this.activeEconomy().buy(i);
    if (ok) {
      this.m_stats.creditsSpent += getWeapon(i).getCost(); // depot-spend stat
      this.poolActiveCredits(); // re-sync squad copies to the debited balance (ECON-1)
    }
    if (ok && this.m_netMode && this.isLocalNetTurn()) this.m_onNetCommand?.({t: 'buy', index: i});
    return ok;
  }

  sellWeapon(i: number): boolean {
    const ok = this.activeEconomy().sell(i);
    if (ok) this.poolActiveCredits(); // re-sync squad copies to the refunded balance (ECON-1)
    if (ok && this.m_netMode && this.isLocalNetTurn()) this.m_onNetCommand?.({t: 'sell', index: i});
    return ok;
  }

  autoBuyWeapons(): void {
    // Net: deterministic (index-order, no Math.random) so a relayed autobuy yields the SAME
    // loadout + credit spend on every client. Solo keeps the varied random assortment.
    this.activeEconomy().autoBuy({deterministic: this.m_netMode});
    this.poolActiveCredits(); // re-sync squad copies to the drained balance (ECON-1)
    if (this.m_netMode && this.isLocalNetTurn()) this.m_onNetCommand?.({t: 'autobuy'});
  }

  /**
   * Drive the acting tank to `destX` and end the turn once it settles — the public
   * seam for a Move action (the network layer's `move` command and, later, replayed
   * remote input; locally the human still moves via aim + a Move weapon through
   * `fire()`). Guarded like `fire()`: only the living, non-moving current tank acts.
   */
  commandMoveTo(destX: number): void {
    if (this.m_paused) return;
    const tank = this.getCurrentTank();
    if (!tank.isAlive() || tank.isMoving()) return;
    this.startTankMove(tank, destX);
  }

  getAngle(): number {
    return this.m_angle;
  }

  getPower(): number {
    return this.m_power;
  }

  getWindValue(): number {
    return this.m_wind.x;
  }

  /** Full 2-D wind velocity, for the "Wind Measurements" LCD ("Vel %.02f %.02f"). */
  getWindVec(): {x: number; y: number} {
    return {x: this.m_wind.x, y: this.m_wind.y};
  }

  /** Wind acceleration (the drift target), for the LCD's "Acc %.02f %.02f". */
  getWindAccel(): {x: number; y: number} {
    return {x: this.m_windAccel.x, y: this.m_windAccel.y};
  }

  /** Whether the acting tank can drive from where it sits (LCD "Can move" /
   *  "Can't move" + "underground"). */
  getCurrentTankCanMove(): boolean {
    return this.getCurrentTank().canMove(this.m_land);
  }

  getCurrentPlayerName(): string {
    return this.getCurrentTank().getName();
  }

  getCurrentTeamColor(): string {
    return TEAM_COLORS[this.getCurrentTank().getTeamId()] || '#ff4444';
  }

  getWinnerName(): string {
    return this.m_winnerName;
  }

  /** The tank the winner flag plants beside — the leading team's representative (top
   *  scorer: kills in Deathmatch, points in Rounds), or null in a draw. In Rounds/Points
   *  mode this may be a dead tank (the flag then plants beside its wreck). */
  getWinnerTank(): CTank | null {
    return this.getLeadingTeam()?.rep ?? null;
  }

  /** DEV (`?endtest=battle|war`): fabricate some stats and end the battle so the
   *  standings screen can be previewed. */
  devForceBattleEnd(): void {
    this.m_tanks.forEach((t, i) => {
      for (let k = 0; k < (this.m_tanks.length - i) * 2; k++) t.addKill();
      for (let k = 0; k < 12; k++) t.addShot();
      for (let k = 0; k < 12 + i; k++) t.addHit(60 - i * 8);
      if (i > 0) {
        t.addDeath();
        t.hit(999999); // everyone but the first tank dies
      }
    });
    this.endTurn();
  }

  /** DEV (`?taunttest=right`): park the winner hard against the right edge and force a
   *  battle end, to check the taunt bubble stays on-screen (tail still on the tank). */
  devTauntEdge(side: 'right' | 'left'): void {
    const t0 = this.m_tanks[0];
    if (t0) {
      // 1-screen land (dev default) → world == view, so the world edge is the view edge.
      t0.respawn(side === 'right' ? this.m_worldWidth - 24 : 24, this.m_land);
    }
    this.devForceBattleEnd();
  }

  /** DEV (`?craterfill=0|1`): carve a row of test craters to preview the Filled Craters
   *  option (fill=true → soil-filled bowls; fill=false → transparent, the default). */
  devCarveTestCraters(fill: boolean): void {
    GameConfig.craterFill = fill;
    for (const f of [0.35, 0.62]) {
      const wx = Math.floor(this.m_worldWidth * f);
      const gy = this.m_land.getHeightAt(wx);
      this.m_land.carveDiscCollapse(wx, Math.floor(gy + 30), 90, true, false, true); // deep bowl → soil face + backdrop
    }
    this.markDirty();
  }

  /** DEV (`?sentrytest=1`): drop a Turret + Minigun sentry beside the human tank and aim
   *  each at its nearest enemy, to preview the deployed sentry sprites + turret rotation. */
  devDropSentries(): void {
    const owner = this.m_tanks[0];
    if (!owner) return;
    const ox = owner.getPosition().x;
    const turret = WEAPON_DATABASE.findIndex(w => w.id === 'sentry.turret');
    const mg = WEAPON_DATABASE.findIndex(w => w.id === 'sentry.minigun');
    this.deploySentry(ox - 60, 0, owner, turret);
    this.deploySentry(ox + 60, 0, owner, mg);
    // Aim each freshly-dropped sentry at the nearest enemy so the turrets read correctly.
    for (const s of this.m_tanks) {
      if (!s.isSentry()) continue;
      const t = this.nearestEnemy(s);
      if (!t) continue;
      s.setTurretAngle(this.aimDegToward(s.getTurretPivot(), t.getPosition()));
    }
    this.markDirty();
  }

  /** The between-battles standings: per-team totals, the leading team, the title /
   *  banner / prompt, and the victor's taunt. Read by the standings overlay. */
  getWarStandings(): WarStandings {
    const deathmatch = this.m_gameType === EGameType.Deathmatch;
    const warOver = this.getWarOver();

    // Group tanks into teams by colour (Sentries are excluded from standings).
    const teams = this.groupTanksByTeam(t => !t.isSentry());

    const rows: WarTeamRow[] = [];
    for (const members of teams.values()) {
      let kills = 0,
        deaths = 0,
        shots = 0,
        hits = 0,
        dmg = 0,
        lifeSum = 0;
      for (const m of members) {
        kills += m.getKills();
        deaths += m.getDeaths();
        shots += m.getShotsFired();
        hits += m.getHitsLanded();
        dmg += m.getDamageDealt();
        lifeSum += clamp01(m.getHealth().nLife / m.getMaxLife());
      }
      rows.push({
        name: members[0].getName(),
        color: members[0].getColor(),
        kills,
        deaths,
        points: Math.round(dmg), // team net damage dealt = the Points metric
        lifePct: (lifeSum / members.length) * 100,
        accuracyPct: shots > 0 ? (hits / shots) * 100 : 0,
        damagePerHit: hits !== 0 ? dmg / hits : 0,
        isLeader: false,
        isHuman: members.some(m => m.isHuman()),
      });
    }

    // Sort + leader are mode-aware: Rounds/Points by points, Deathmatch by kills (tie →
    // higher team life%). The leader (getLeadingTeam) also decides Rounds ties → Draw.
    const rounds = !deathmatch;
    rows.sort((a, b) =>
      rounds
        ? b.points - a.points || b.lifePct - a.lifePct
        : b.kills - a.kills || b.lifePct - a.lifePct,
    );
    const leader = this.getLeadingTeam();
    const draw = !leader && rows.length > 0; // Rounds only: every team finished level
    if (leader && rows.length) rows[0].isLeader = true;
    const leaderName = leader ? rows[0].name : '';

    const ws = strings.value.warStandings;
    const title = draw
      ? ws.draw
      : !leaderName
        ? ''
        : rounds
          ? fmt(ws.winsBattle, {name: leaderName})
          : warOver
            ? fmt(ws.winsWar, {name: leaderName})
            : fmt(ws.winningWar, {name: leaderName});

    const subtitle: string[] = [];
    if (deathmatch && !warOver) {
      subtitle.push(ws.notOver);
      subtitle.push(fmt(ws.battleCompleted, {n: this.m_currentBattle, total: this.m_totalBattles}));
    }

    // Victory!/Defeat! banner — ONLY when the whole war is over (the legacy war-end
    // screen). Between battles there is no banner. Reflects the human's outcome: a win if
    // the human's team leads. Rounds/Points is decided by points (a winner even with no
    // survivors), so it never shows "all dead"; a level tie shows the Draw banner.
    let banner = '';
    if (warOver) {
      if (draw) banner = ws.draw;
      else if (deathmatch && !this.m_tanks.some(t => t.isAlive())) banner = ws.allDead;
      else if (!this.m_tanks.some(t => t.isHuman()))
        banner = ''; // all-bots (demo)
      else banner = (leader?.human ?? false) ? ws.victory : ws.defeat;
    }

    return {
      title,
      banner,
      subtitle,
      winCondition: deathmatch ? ws.winConditionKills : '',
      rows,
      pointsMode: rounds,
      prompt: warOver ? ws.exitPrompt : ws.nextPrompt,
      warOver,
    };
  }

  /** Per-team Battle Heroes values, submitted to the hall of fame at war end: each
   *  team's total kills (the Kills board) and its average damage-dealt per tank (the
   *  Score board). One entry per team; the callsign is the team's name. */
  getBattleHeroes(): BattleHeroTeam[] {
    const teams = this.groupTanksByTeam(t => !t.isSentry());
    const out: BattleHeroTeam[] = [];
    for (const members of teams.values()) {
      let kills = 0,
        dmg = 0;
      for (const m of members) {
        kills += m.getKills();
        dmg += m.getDamageDealt();
      }
      out.push({name: members[0].getName(), score: Math.round(dmg / members.length), kills});
    }
    return out;
  }

  /** Consume the last battle's win/lose outcome for the local human (once). Returns
   *  null when there's nothing pending, so the UI can poll it each frame. */
  takeBattleOutcome(): 'won' | 'lost' | null {
    const o = this.m_pendingBattleOutcome;
    this.m_pendingBattleOutcome = null;
    return o;
  }

  /** Register a callback invoked at each shot impact (world x, y, strength). */
  setImpactListener(cb: (x: number, y: number, strength: number) => void): void {
    this.m_onImpact = cb;
  }

  /** Register the global-stats hook: called as each battle (and the war it closes) completes so the
   *  UI can drain (takeStatsDelta) and upload the play banked so far. Fires on EVERY client in a net
   *  match; the UI decides who actually uploads (isStatsUploader). */
  setStatsListener(cb: (closed: StatsFlush) => void): void {
    this.m_onStats = cb;
  }

  /** Weapon-test mode (?weapontest=1): the AI never takes a turn and the human's
   *  shot timer is disabled, so weapons can be fired back-to-back indefinitely. */
  setWeaponTest(on: boolean): void {
    this.m_weaponTest = on;
    // Weapon-test = unlimited ammo. Express that ONCE, as economy state, so the depot,
    // arsenal and fire path all read it from one place (no per-site weapon-test checks).
    this.m_economy.setFreeFire(on);
  }

  /** Wire the audio facade (SFX + music). Optional — the game runs silently without it. */
  setAudio(audio: CAudio): void {
    this.m_audio = audio;
    this.m_audio.setWorldWidth(this.m_worldWidth); // stereo pan spans the whole world
  }

  getAudio(): CAudio | null {
    return this.m_audio;
  }

  // ========================================================================
  // ACCESSORS
  // ========================================================================

  getState(): EGameState {
    return this.m_gameState;
  }

  /** True once the first battle has been started. While false (fresh boot → main menu) there
   *  is no land/tanks/combat audio and the sim/render/HUD-sync work all short-circuit. */
  isStarted(): boolean {
    return this.m_started;
  }

  /**
   * Resolve once THIS match's visuals are loaded: the landscape background (sky) + the
   * depth-layered terrain textures have loaded and been handed to CLand, and every other
   * sprite queued by startGame (tanks, weapon/FX art) has settled. The UI holds a loading
   * screen on this so the battle is revealed fully textured instead of flashing the
   * gradient-sky / untextured-terrain fallback. Resolves after at most `maxWaitMs` even if
   * an asset hangs, so the loading screen can never trap the player.
   */
  async assetsReady(maxWaitMs = 10000): Promise<void> {
    await this.m_loadPromise; // sky + terrain layers loaded and applied to CLand
    // Then poll until every other queued sprite (tanks, weapon/FX art) has settled, capped so a
    // hung asset can never trap the loading screen.
    const deadline = performance.now() + maxWaitMs;
    await new Promise<void>(resolve => {
      const poll = (): void => {
        if (this.m_assets.isReady() || performance.now() >= deadline) resolve();
        else setTimeout(poll, 16);
      };
      poll();
    });
    // The sprites the particle system bakes from (gui/rocket plume.bmp) are loaded now, so build
    // the exhaust atlas here rather than letting it build lazily on the first rocket — that would
    // put its one-off cost on the frame the shot is fired (the "first fire is laggy" class of hitch).
    this.m_particles.prewarm();
  }

  /** True while the human is jet-flying (Flying state). */
  isFlying(): boolean {
    return this.m_gameState === EGameState.Flying;
  }

  /** Remaining jet fuel (seconds) of the current tank — 0 when not flying. */
  getJetFuel(): number {
    return this.getCurrentTank().getJetFuel();
  }

  isPlayerTurn(): boolean {
    // In Demo Mode the AI drives the human too, so the human never "has control".
    if (GameConfig.demo) return false;
    // Null-safe: before a match starts there is no current tank (the arsenal preview
    // and other read-only accessors can run then), so no one "has control".
    // In a network match only the LOCAL player controls their own turn; on everyone
    // else's turn the tank is driven from the wire, so local input is locked out.
    if (this.m_netMode && this.m_currentPlayerIndex !== this.m_netLocalIndex) return false;
    return this.getCurrentTank()?.isHuman() === true && this.m_gameState === EGameState.Battle;
  }

  /**
   * The SINGLE gate the input layer + HUD key off (`blocked` / `canFire` signals, `beginAim`):
   * can the human act — aim, fire, use the HUD — RIGHT NOW? False while paused, in Demo, on a
   * remote net turn, outside the Battle phase (jet flight / shot flying / explosion all leave it),
   * or while the current tank is auto-driving a Move (isMoving/isFalling). So a Move — exactly like
   * a jet flight — locks out ALL player input until it settles and the turn hands on.
   */
  canAct(): boolean {
    if (this.m_paused || !this.isPlayerTurn()) return false;
    const tank = this.getCurrentTank();
    return !tank.isMoving() && !tank.isFalling();
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================

  private m_ctx: CanvasRenderingContext2D;

  // Large-map camera (horizontal only). The world is `m_worldWidth` px wide; the
  // scene canvas is the view. `m_camX` = world X of the view's left edge (current,
  // eased); `m_camTargetX` = where it's heading. `m_manualScroll` = the player
  // dragged the minimap, which suppresses auto-follow until fire / turn change.
  private m_worldWidth = 0;
  private m_camX = 0;
  private m_camTargetX = 0;
  private m_camDwell = 0; // Cinematic camera: seconds left lingering on the impact before the pan (see beginTurn)
  private m_manualScroll = false;
  // The ONE shot the camera tracks this turn (latched to the first of a salvo, so it
  // doesn't zig-zag across a multi-missile volley — the original follows a single
  // active shot). Null once reset each turn; may point at a now-dead shot.
  private m_activeShot: CShot | null = null;
  // World X of the most recent blast — the camera holds here while the explosion
  // animation plays out, so a nuke finishes on screen before the turn hands off.
  private m_lastImpactX = 0;
  private m_impactThisTurn = false; // did a blast land this turn? (gates the Cinematic camera dwell)

  private m_land: CLand;
  private m_tanks: CTank[] = [];
  private m_shots: CShot[];
  private m_pendingSalvos = 0; // succession salvos still scheduled to fire this shot
  private m_weaponTest = false; // ?weapontest=1: AI never takes a turn (endless firing)

  // ── Networked match state ────────────────────────────────────────────────
  // Set by startNetworkGame(). In net mode the server is the turn arbiter: turns
  // don't advance locally (endTurn defers to m_onNetTurnEnd), local input is limited
  // to the local player's tank, and terrain is seeded so every client starts identical.
  private m_netMode = false;
  private m_netLocalIndex = -1; // which tank index this client controls
  private m_terrainSeed: number | null = null; // shared seed → identical terrain
  private m_netRoster: {name: string; color: string}[] | null = null;
  private m_onNetTurnEnd: (() => void) | null = null;
  private m_onNetCommand: ((cmd: GameCommand) => void) | null = null;
  // Live aim relay (net): while the local player adjusts angle/power, stream throttled `aim`
  // commands so spectators watch the turret track in real time (not just snap at fire). Purely
  // cosmetic — the deterministic outcome still comes from the final aim re-sent at fire.
  private m_netAimDirty = false;
  private m_lastAimSentTime = 0;
  // Jet-flight relay (net): the last thrust state sent to peers this flight, so a repeated
  // setJetInput (key auto-repeat) doesn't spam the wire — only real CHANGES relay. Reset per flight.
  private m_lastJetRelay: {up: boolean; left: boolean; right: boolean} | null = null;
  private m_bootingNet = false; // true only while startNetworkGame drives startGame
  private m_netLandScale = NET_LAND_SCALE; // host-chosen net world width (viewport-widths)
  private m_netViewW = NET_VIEW_W; // shared net logical size = the HOST's view size
  private m_netViewH = NET_VIEW_H;
  private m_netTanksPerTeam = 1; // squad size in net → maps active tank index to its owner
  // netMode: a turn's action (shot/move/utility) is mid-resolution. The net bridge holds
  // the server's next `turnBegin` until this clears, so a late hand-off can't interrupt
  // an in-flight local simulation.
  private m_netShotResolving = false;
  // Fixed LOGICAL view/world dimensions (px), decoupled from the render canvas. The sim
  // works in these; draw() scales them to the live native canvas so a resize stays crisp
  // and never regenerates the world. Set in startGame (solo = boot size, net = constant).
  private m_viewW = 1;
  private m_viewH = 1;
  private m_displayW = 1;
  private m_displayH = 1;
  // Draw-only projectiles a spectator flies from a relayed fire — pure visual (the
  // authoritative snapshot does the real damage/terrain); never carve or hit.
  private m_ghostShots: CShot[] = [];

  // Per-match play-stat tallies (uploaded INCREMENTALLY for the global About counters — see
  // takeStatsDelta). Reset in startGame; in a net match every client tallies (all simulate every
  // shot) but only ONE uploads.
  private m_stats = {
    weaponsFired: 0, // fire actions committed
    shotsFired: 0, // individual projectiles/rounds launched
    nukesFired: 0, // super-weapon (NUKE-class) fires
    tanksDestroyed: 0, // tank kills
    terrainCarved: 0, // ground-carving blasts (craters)
    creditsSpent: 0, // depot spend
  };
  // The tallies as of the last stats drain — everything past this has yet to be uploaded.
  private m_statsBase: MatchStatTally = freshStatTally();
  // Fired when a unit of progress completes (round / battle / war) so the UI can bank the delta.
  private m_onStats: ((closed: StatsFlush) => void) | null = null;
  private m_matchStartTime = 0; // m_time captured at startGame → this match's play seconds
  // The single GAMEPLAY random stream — seeded per match so a shot resolves identically
  // on every client (lockstep). Cosmetic randomness (particles/weather/taunts) stays on
  // Math.random and must NOT draw from here, or frame-rate differences would desync it.
  private m_rng = new Prng(1);

  private m_particles: CParticleSystem;
  private m_weather: CWeather;
  private m_economy: CEconomy;
  // Per-bot weapon inventories (the human's is m_economy). Bots buy a difficulty-scaled loadout
  // at turn start and consume rounds as they fire, like the original AI. Lazily created, bound to
  // each bot tank's own credits; cleared per match.
  private readonly m_botEconomy = new Map<CTank, CEconomy>();
  // Ultra ranging memory: where each tank's last primary shot LANDED, and the aim (target + power) it
  // was fired with — so an Ultra bot corrects its next shot's power off the observed over/undershoot.
  // Ultra ranging memory — ONE atomic record per bot: the last shot's aim (target + fired ANGLE +
  // power) and, once that exact shot lands on the ground, where it landed. Kept together (not two
  // maps) so the landing always belongs to the shot that produced it. The angle is held constant while
  // walking a target so the power↔range relation stays monotonic (a fresh solver angle each turn would
  // jump basins and the landing wouldn't track power) — only the power is corrected.
  private readonly m_ultraShot = new Map<
    CTank,
    {targetX: number; weapon: number; angle: number; power: number; landedX?: number}
  >();
  // Each Ultra bot's personality (weights), drawn once per match so two Ultra bots play differently.
  private readonly m_ultraPersonality = new Map<CTank, UltraWeights>();
  // Each Ultra bot's life at the START of its previous turn — a drop means an enemy has its range
  // (it was shelled during the opponent's turn), so it should seek cover.
  private readonly m_ultraLastLife = new Map<CTank, number>();
  // FRIENDLY-FIRE LEDGER: life each tank has taken off its OWN side. Nobody keeps covering for the one
  // who keeps hitting them — a squadmate's Ultra planner reads this and slides that tank from "protect
  // at all costs" toward "fair game" as it climbs. Per battle (cleared with the rest of the match state).
  private readonly m_friendlyDamage = new Map<CTank, number>();
  // What each TEAM has actually been firing (nukes / beams / dirt), so an opponent can read intent on
  // top of inventory: a side that has thrown two nukes is telling you what the third one is for.
  private readonly m_ultraEnemyFire = new Map<
    number,
    {nukes: number; beams: number; earth: number; shots: number}
  >();
  private m_mapName = ''; // set (localised) on each map load; '' pre-load, never surfaced
  private m_screenShake: ScreenShake;
  private m_assets: CAssetManager;
  private m_onImpact: ((x: number, y: number, strength: number) => void) | null = null;
  private m_smokeSink: ISmokeSink | null = null;
  private m_audio: CAudio | null = null;
  private m_tanksMoving = false; // tracks the tank-moving loop state
  private m_jetSounding = false; // tracks the jet.wav loop state

  // Placed mines from special weapons, and Tracer aim markers. (Sentries are full tanks
  // in m_tanks — see deploySentry — not placed-marker records.)
  private m_mines: {
    x: number;
    y: number;
    vy: number; // vertical fall speed — non-zero only while dropping into a fresh hole
    owner: CTank | null;
    weaponIndex: number;
    armed: number;
  }[] = [];
  // Marks which live sentry tanks are the Minigun variant (→ fire "Machine Gun", not Shell).
  private m_sentryMinigun: WeakSet<CTank> = new WeakSet();
  private m_aimMarkers: {x: number; y: number; label?: string}[] = [];
  // Floating "Show Points" damage numbers (world pos + age); rise + fade over DMG_NUM_LIFE.
  private m_damageNumbers: {x: number; y: number; text: string; age: number}[] = [];
  // "Show Blast Circles": a ring per explosion at its damage radius; fades over BLAST_CIRCLE_LIFE.
  private m_blastCircles: {x: number; y: number; r: number; age: number}[] = [];
  // Victory fireworks (war-end, human wins). Spawned + aged during BattleEnd; drawn in
  // the sky behind the standings overlay. `m_showFireworks` is decided once at battle end.
  private m_fireworks: Firework[] = [];
  private m_rockets: FwRocket[] = [];
  private m_fireworkTimer = 0;
  private m_showFireworks = false;
  // Supply crates on the field + their pickup messages, and a monotonic id counter.
  private m_crates: Crate[] = [];
  private m_floatTexts: FloatText[] = [];
  private m_crateSeq = 0;
  // Live taunt speech bubbles (Chatter). One per speaker at a time; a new one replaces
  // the old. Aged in update(); rendered as DOM overlays via getActiveTaunts().
  private m_bubbles: TauntBubble[] = [];
  private m_bubbleSeq = 0;
  private m_tauntTimer = TAUNT_IDLE_MIN; // idle-taunt countdown, re-armed each turn
  private m_firedThisTurn = false; // gate post-fire taunts to turns where a shot was taken
  // Cached pixel data of structure bitmaps (bunker.bmp / wall.bmp) for buildStructure.
  private m_structImages = new Map<string, {width: number; height: number; data: Uint32Array}>();

  // Free-running clock for animated indicators (bouncing turn triangle) — also
  // the timebase for scheduled game-flow actions (see m_timers), so both freeze
  // together while paused.
  private m_time: number = 0;
  private m_screenFlash: number = 0; // full-viewport white-out intensity (0..1), decays each frame
  private m_flashColor: string = '#ffffff'; // weapon-tinted flash colour
  // Deferred sim-clock actions (bot turns, turn hand-off): {at: sim-time due, fn}.
  private m_timers: {at: number; fn: () => void}[] = [];
  // Whole-game pause: freezes the sim clock (update is skipped) and audio.
  private m_paused: boolean = false;
  // Present-on-demand gate: the loop keeps ticking, but the heavy 2D redraw + GPU
  // upload are skipped on frames where nothing visible changed (see shouldRedraw).
  private m_renderGate = new RenderGate();
  // Live drag-aim state: the world-space target the player is dragging toward.
  private m_aim: {active: boolean; tx: number; ty: number} = {active: false, tx: 0, ty: 0};
  // Move utility: FIRE arms "click-to-place" mode — the move band brightens, the cursor turns to a
  // hand, and the next click in the band drives the tank there (placeMove). Reset on weapon/turn change.
  private m_movePlacing = false;
  // A committed Move drive is resolving (tank driving to its placed spot, turn about to end). Keeps the
  // green move-AREA hidden through the gap between the drive stopping and endTurn firing — otherwise the
  // band flashes back for a frame or two (up to one waitForRest poll). Cleared on turn-begin.
  private m_moveResolving = false;
  // Last known mouse position in world coords (for hover-detail on tank badges).
  private m_mouse: {x: number; y: number} = {x: -1, y: -1};

  setMouse(wx: number, wy: number): void {
    this.m_mouse.x = wx;
    this.m_mouse.y = wy;
    this.markDirty();
  }

  // Top-left status counters ("Battle %d of %d - Shot %d").
  private m_shotsFired = 0;
  private m_currentBattle = 1;
  private m_totalBattles = 2; // original default (overridden by Settings → Battles)
  private m_totalRounds = 10; // rounds in a Point game (Play → Rounds)

  // Gameplay config pushed from the Settings menu (see ui/applySettings). Start-time
  // values (credits, land shape) are read in startGame; the rest are read live.
  private m_startCredits = START_CREDITS;
  private m_humanCount = 1; // how many teams are human (the first N); rest CPU
  private m_tanksPerTeam = 1; // squad size — tanks each player fields (Play → Tanks)
  // Distinct teams (= players) this match spawned, fixed at startGame. Teams form by hull colour,
  // so this is the colour count, not nPlayers — two roster slots sharing a colour are ONE side.
  // Read by getStatusCompact to decide whether the status overlay lists everyone.
  private m_teamCount = 0;
  // Each team's PLAYER name — the roster/lobby name without the "… 2" squad suffix its individual
  // tanks carry. The status overlay lists one row per team, so it labels rows from here.
  private m_teamNames = new Map<number, string>();
  private m_landMode = -1; // -1 = random landscape; 0..4 = a forced shape
  private m_flatLand = false; // DEV `?flatland=1`: force a flat test surface next startGame
  private m_windScale = 1; // 0 disables wind
  private m_variance = true; // per-shot inaccuracy on/off
  private m_speedScale = 1; // game-speed multiplier (Update Scale / 10)
  // Fixed-timestep accumulator: the sim advances in FIXED_DT slices so a shot resolves
  // in a deterministic number of steps regardless of frame rate — the other half of
  // lockstep determinism (with the seeded RNG). Tests still drive update(dt) directly.
  private m_simAccum = 0;
  private static readonly FIXED_DT = 1 / 60;
  // Max accumulated sim time (s). Bounds catch-up after a long stall without DROPPING
  // steps (which would desync a networked match). ~0.5s covers any frame hitch.
  private static readonly MAX_SIM_ACCUM = 0.5;
  private m_sellRate = SELL_REFUND; // depot sell-back fraction (mirrors m_economy's, for config)
  private m_creditDamage = CREDIT_PER_DAMAGE; // credits earned per point of life removed
  private m_creditKill = CREDIT_PER_KILL; // credits earned per kill (Deathmatch)
  private m_creditTurn = CREDIT_PER_TURN; // credits earned by each survivor per turn
  private m_creditRound = CREDIT_PER_ROUND; // credits earned by each survivor per round
  private m_gameType = EGameType.Deathmatch; // match type (kill credit is Deathmatch-only)
  private m_currentRound = 1; // completed turn-order passes + 1

  getShotCount(): number {
    return this.m_shotsFired;
  }

  /** The top-left status line: "Round N of M" in Rounds/Points, else "Battle N of M -
   *  Shot X" in Deathmatch. */
  getStatusLine(): string {
    const g = strings.value.game;
    if (this.m_gameType === EGameType.Rounds) {
      return fmt(g.statusRound, {
        round: Math.min(this.m_currentRound, this.m_totalRounds),
        total: this.m_totalRounds,
      });
    }
    return fmt(g.statusBattle, {
      battle: this.m_currentBattle,
      total: this.m_totalBattles,
      shot: this.m_shotsFired,
    });
  }

  /** Transient status hint under the battle line: "Can't move underground." while the acting tank is
   *  buried (Bury Tanks) — matching the original's top-left message. '' when there's nothing to say. */
  getStatusNotice(): string {
    const tank = this.getCurrentTank();
    if (tank?.isAlive() && tank.isBuried()) return strings.value.game.cantMoveUnderground;
    return '';
  }

  getBattleNum(): number {
    return this.m_currentBattle;
  }

  getTotalBattles(): number {
    return this.m_totalBattles;
  }

  // Sole reader of m_totalRounds (fed from settings via setTotalRounds); kept so the
  // Play → Rounds setting stays wired until the round loop consumes it.
  getTotalRounds(): number {
    return this.m_totalRounds;
  }

  /** Per-TEAM life status for the top-left overlay ("%s: %d%% life") — one row per player, not per
   *  tank, as in the original. A squad's percentage is the AVERAGE of its members' life fractions
   *  (dead members count as 0), so a 5-tank player still occupies a single row. Rows follow the
   *  tank array's first-appearance order, and sentries are skipped — they're deployed turrets, not
   *  a side, and would drag their owner's average down. */
  getTeamStatuses(): {
    name: string;
    lifePct: number;
    color: string;
    alive: boolean;
    active: boolean;
  }[] {
    const cur = this.m_tanks[this.m_currentPlayerIndex];
    const order: number[] = [];
    const acc = new Map<number, {sum: number; n: number; color: string; alive: boolean}>();
    for (const t of this.m_tanks) {
      if (t.isSentry()) continue;
      const id = t.getTeamId();
      let e = acc.get(id);
      if (!e) {
        e = {sum: 0, n: 0, color: t.getColor(), alive: false};
        acc.set(id, e);
        order.push(id);
      }
      const max = t.getMaxLife();
      e.sum += max > 0 ? Math.max(0, t.getHealth().nLife / max) : 0;
      e.n++;
      if (t.isAlive()) e.alive = true;
    }
    const curTeam = cur && !cur.isSentry() ? cur.getTeamId() : -1;
    return order.map(id => {
      const e = acc.get(id)!;
      return {
        name: this.m_teamNames.get(id) ?? '',
        lifePct: Math.round((e.sum / Math.max(1, e.n)) * 100), // → 0..100, averaged over the squad
        color: e.color,
        alive: e.alive,
        active: id === curTeam,
      };
    });
  }

  /** Should the top-left overlay stop listing every team? True past STATUS_LIST_ROWS PLAYERS, as
   *  in the original: up to four sides are listed in full, and from the fifth on the list is cut
   *  down rather than running a roster down the screen. Keyed on the team count, not the tank
   *  count — rows are per team (see getTeamStatuses), so four players cost four rows whether they
   *  field one tank each or five. What replaces the full list is {@link getStatusScroll}'s call.
   *  The mobile HUD's dot row ignores all of this: one small dot per team stays readable. */
  getStatusCompact(): boolean {
    return this.m_teamCount > CGameController.STATUS_LIST_ROWS;
  }

  /** Rows the top-left status overlay will print. Doubles as the player count it starts cutting
   *  the list at: 4 sides fit, the 5th makes it compact (see getStatusCompact). */
  private static readonly STATUS_LIST_ROWS = 4;

  /** Rows the status overlay shows once it's compact — also the player count it starts cutting at. */
  getStatusListRows(): number {
    return CGameController.STATUS_LIST_ROWS;
  }

  /** Scroll Status List (Graphics): once compact, show a WINDOW of rows that follows the turn
   *  (players 1-4, then 2-5, …) instead of the acting player's row alone. Off = the original's
   *  behaviour. Purely local presentation — never shared in a net match. */
  getStatusScroll(): boolean {
    return GameConfig.statusScroll;
  }

  // The aim (angle, power) at turn start — anchors the faded "initial" target cross.
  private m_turnStartAngle: number = 45;
  private m_turnStartPower: number = 500;

  // Round Timer countdown (the "Round Timer" gameplay setting, seconds; 0 = off). The human
  // has GameConfig.roundTime seconds to aim + fire; the panel bar below FIRE drains
  // green→yellow→red and, on expiry, the turn is forfeited. When off, turns are untimed and
  // the bar shows an inert dark track. In net play the host's value is shared via MatchConfig.
  private m_turnElapsed: number = 0;
  // Only counts while awaiting the human's shot: true from beginTurn (human,
  // limit on) until fire()/expiry/turn-end. Bots never time out.
  private m_turnTimerRunning: boolean = false;

  // Fire wind-up: when a human commits a real shot (via requestFire), the FIRE bar charges red
  // 0→full over FIRE_CHARGE_TIME, flashes green for FIRE_GREEN_HOLD, then updateFireCharge calls
  // fire() to launch. Purely a local presentation gate on the acting client — bots, net peers and
  // tests call fire() directly (immediate), and peers get the relayed 'fire' at charge end, so the
  // deterministic sim is unaffected.
  private static readonly FIRE_CHARGE_TIME = 0.4;
  private static readonly FIRE_GREEN_HOLD = 0.1;
  private m_charging: boolean = false;
  private m_chargeElapsed: number = 0;
  // Latch so the acting-tank passive-death forfeit fires endTurn ONCE per turn (re-armed in beginTurn),
  // not every frame while awaiting the server's net turn hand-off. See the forfeit in updateBattle.
  private m_turnForfeited = false;
  // Bumped every beginTurn. HUD aim drags (power meter / angle dial) capture it on grab and bail when
  // it changes, so a drag held across a turn hand-off can't scrub the next player's aim. See turnSeq().
  private m_turnSeq = 0;

  // Game state machine
  private m_gameState: EGameState = EGameState.Battle;
  // False until the first startGame(): no land is generated, no tanks spawned, and no
  // combat assets/music are loaded while we sit on the main menu. The per-frame sim +
  // render + HUD-sync work all short-circuit on this, so the menu does zero battle work
  // until the player actually starts a match (Play / Quick Play / a dev URL flag).
  private m_started = false;
  // The in-flight landscape load for the current match (bg + terrain layers). assetsReady()
  // awaits it so the loading screen lifts only once the world is textured. Re-armed by every
  // battle of a war, which rolls a fresh landscape (see loadLandscape).
  private m_loadPromise: Promise<void> = Promise.resolve();
  // Asset key of the CURRENT battle's sky ('bg:<file>'), empty until the first one decodes (the
  // draw falls back to the gradient sky). Swapped only once the new image is in the cache, so a
  // battle change cuts straight from one sky to the next.
  private m_bgKey = '';
  private m_currentPlayerIndex: number = 0;

  // Firing controls
  private m_angle: number;
  private m_power: number;
  private m_currentWeaponIndex: number; // Index into WEAPON_DATABASE

  // Physics — wind is a slowly-drifting 2-D vector (display units, ~±5).
  private m_wind: Vec2 = new Vec2(0, 0);
  private m_windAccel: Vec2 = new Vec2(0, 0);
  private m_windTimer: number = 0;
  // Effective wind actually fed to the physics each frame: the sustained `m_wind` plus Realistic-mode
  // gusts. In Linear mode it equals `m_wind`. The LCD / snapshot report the sustained wind (m_wind),
  // so gusts are felt (shots, smoke, crates all breathe) without the readout jittering.
  private m_effWind: Vec2 = new Vec2(0, 0);
  private m_gustT = 0; // gust-oscillator clock (seconds), advanced every frame
  // Terrain-surface provider handed to shots so the shared wind profile (core/wind.ts) can
  // attenuate drift near the ground in Realistic mode. Reads m_land live (it's re-created per map).
  private m_windGroundAt = (x: number): number => this.m_land.getHeightAt(Math.floor(x));
  private m_difficulty: number = AI_DEFAULT_LEVEL; // computer-player skill

  private m_winnerName: string = '';
  private m_battleEndTime = 0; // seconds since the battle ended (winner-flag animation)
  // Last battle's outcome for the local human, pending pickup by the UI (Battle Heroes
  // won/lost tally). Set once at battle end, cleared when consumed via takeBattleOutcome.
  private m_pendingBattleOutcome: 'won' | 'lost' | null = null;
}
