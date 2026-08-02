/**
 * Typed access to the engine's soft-private internals, for tests.
 *
 * Engine fields are `m_`-prefixed TS soft-privates (see AGENTS.md) — reachable at runtime, which
 * both the browser verify harness and these tests rely on. Reaching them needs a cast, and every
 * test file used to hand-roll its own: 31 files declared their own `type Priv = {...}`, `m_tanks`
 * alone was re-declared in 41 of them, and there were 200+ `as unknown as` casts. Renaming a field
 * meant hunting every one.
 *
 * One declaration per engine class lives here instead, and `priv()` / `landPriv()` / … do the cast.
 * These are intentionally WIDE — a test gets the whole internal view, not a bespoke slice — because
 * the point is a single place to update, not minimal exposure to a test that can already reach
 * everything anyway.
 *
 * Only add a member here when a test genuinely needs it. If a test is reaching for something just
 * to observe a result, prefer a public accessor (or extracting the logic into its own object, the
 * way `CChatter` / `botEconomy` made their tests controller-free).
 */
import type {CGameController, EGameState} from '../src/game/CGameController';
import type {CLand} from '../src/core/CLand';
import type {CTank} from '../src/core/CTank';
import type {CShot} from '../src/core/CShot';
import type {CEconomy} from '../src/core/CEconomy';
import type {CParticleSystem} from '../src/core/CParticleSystem';

/** A queued timer entry (`schedule`). */
interface Timer {
  at: number;
  fn: () => void;
}

/** The CGameController internals tests reach for. */
export interface GCPriv {
  // ── match state ──
  m_tanks: CTank[];
  m_land: CLand;
  m_particles: CParticleSystem;
  m_gameState: EGameState;
  m_currentPlayerIndex: number;
  m_currentRound: number;
  m_currentBattle: number;
  m_shotsFired: number;
  m_shots: CShot[];
  m_activeShot: CShot | null;
  m_mines: {
    x: number;
    y: number;
    vy: number;
    armed: number;
    weaponIndex: number;
    owner: CTank | null;
  }[];
  m_timers: Timer[];
  m_pendingSalvos: number;
  m_battleEndTime: number;
  m_time: number;
  m_lastImpactX: number;
  m_aim: {active: boolean; x: number; y: number};
  m_wind: {x: number; y: number};
  m_rng: {float(): number; int(n: number): number; getState(): number; seed(n: number): void};
  m_viewW: number;
  m_viewH: number;
  m_worldWidth: number;
  m_currentWeaponIndex: number;
  m_speedScale: number;
  m_variance: boolean;
  m_landMode: number;
  m_windScale: number;
  m_turnElapsed: number;
  m_turnTimerRunning: boolean;
  m_impactThisTurn: boolean;
  m_firedThisTurn: boolean;
  m_tanksMoving: boolean;
  m_jetSounding: boolean;
  // ── extracted subsystems (see src/game/*) ──
  m_camera: {reset(): void; isDwelling(): boolean; isShaking(): boolean; x(): number};
  m_crateField: {
    list(): readonly {x: number; y: number; kind: string; weaponIndex: number}[];
    update(dt: number, env: unknown): void;
  };
  m_markers: {hasAny(): boolean};
  // ── network ──
  m_netMode: boolean;
  m_netShotResolving: boolean;
  m_onNetTurnEnd: (() => void) | null;
  // ── private methods driven directly ──
  beginTurn(): void;
  endTurn(): void;
  updateBattle(dt: number): void;
  endBattleIfDecided(): boolean;
  economyFor(tank: CTank): CEconomy;
  executeBotTurn(): void;
  botAimAndFire(tank: CTank): void;
  botMove(tank: CTank): boolean;
  cameraFollowX(): number;
  crateEnv(): unknown;
  addCrate(x: number, forced?: string): void;
  collectCrate(crate: unknown, tank: CTank): void;
  creditDamage(shooter: CTank | null, victim: CTank, lifeRemoved: number): void;
  settleMines(dt: number): void;
  armShotClock(fresh: boolean): void;
  startTankMove(tank: CTank, destX: number): void;
  executeSentryTurn(): void;
  fire(): void;
  awardKillCredit(victim: CTank): void;
  handleTankDestroyed(tank: CTank): void;
}

/** The CLand internals tests reach for (terrain buffers are the whole point of most land tests). */
export interface LandPriv {
  m_arrHeights: Int16Array;
  m_pixels: Uint32Array;
  m_material: Uint8Array;
  m_layers: unknown;
  m_nWidth: number;
  m_nHeight: number;
  m_spoil: {x: number; y: number; vx: number; vy: number; age: number; radSlot: number}[];
  // Mirrors CLand's RadSpeck / RadParticle. Kept structural rather than importing the real types:
  // they are module-private to CLand, and a test only ever reads a few fields off them.
  m_radSpecks: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    age: number;
    life: number;
    settled: boolean;
    size: number;
    rise: number;
    slot: number;
    r: number;
    g: number;
    b: number;
  }[];
  m_radParticles: {
    x: number;
    y: number;
    radius: number;
    damagePerSecond: number;
    timeRemaining: number;
    duration: number;
    slot: number;
    r: number;
    g: number;
    b: number;
  }[];
  m_rngState: number;
  // Cached radiation-glow TILES + the layer's origin (rebuilt only when the hot earth changes).
  m_radGlowCanvas: (HTMLCanvasElement | undefined)[];
  m_radGlowX: number;
  m_radGlowY: number;
  /** Per-slot RGB palette — which colour each detonation's contaminated earth glows. */
  m_radSlotRGB: [number, number, number][];
}

/** The NetGame internals tests reach for (the busy-queue behaviour). */
export interface NetGamePriv {
  m_queue: unknown[];
  drainQueue(): void;
}

/** The CTank internals tests reach for. */
export interface TankPriv {
  m_bIsAlive: boolean;
  m_bExploded: boolean;
  m_bBuried: boolean;
  m_vVel: {x: number; y: number};
  m_driveTargetX: number | null;
  m_leftOwner: boolean;
  /** Place the tank on the terrain (private; the controller calls it during spawn). */
  init(x: number, land: CLand): void;
}

/** The CParticleSystem internals tests reach for. Mirrors its module-private `Particle` for the
 *  fields the draw/emit tests assert on. */
export interface ParticlesPriv {
  m_particles: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    g: number;
    b: number;
    age: number;
    life: number;
    size: number;
    kind: string;
  }[];
  m_explosions: {x: number; y: number; age: number; life: number}[];
  m_craterVents: {x: number; y: number; r: number; age: number}[];
  /** Push one particle of a given render kind straight into the pool — the private emitter, so a
   *  test can exercise a single kind's draw branch without a whole blast. */
  add(
    x: number,
    y: number,
    vx: number,
    vy: number,
    c: {r: number; g: number; b: number},
    life: number,
    size: number,
    kind: string,
  ): void;
  clearSmoke(x: number, y: number, r: number): void;
  /** Returns an HTMLCanvasElement in the real engine; typed structurally here because the draw
   *  tests run without a DOM and substitute a minimal stand-in to select the baked-atlas branch. */
  exhaustAtlas(): {width: number; height: number} | null;
}

/**
 * Field manifests, used by `internals.test.ts` to prove these interfaces still match the engine.
 *
 * A cast can't check that `m_tanks` exists — that's the hole the hand-rolled per-file types had, and
 * a rename would silently leave every test asserting against `undefined`. `Record<keyof X, true>`
 * forces this object to carry EXACTLY the interface's keys (a missing or extra one is a compile
 * error), so the guard test can iterate them and confirm each is really present on an instance.
 */
export const GC_KEYS: Record<keyof GCPriv, true> = {
  m_tanks: true,
  m_land: true,
  m_particles: true,
  m_gameState: true,
  m_currentPlayerIndex: true,
  m_currentRound: true,
  m_currentBattle: true,
  m_shotsFired: true,
  m_shots: true,
  m_activeShot: true,
  m_mines: true,
  m_timers: true,
  m_pendingSalvos: true,
  m_battleEndTime: true,
  m_time: true,
  m_lastImpactX: true,
  m_aim: true,
  m_wind: true,
  m_rng: true,
  m_viewW: true,
  m_viewH: true,
  m_worldWidth: true,
  m_currentWeaponIndex: true,
  m_speedScale: true,
  m_variance: true,
  m_landMode: true,
  m_windScale: true,
  m_turnElapsed: true,
  m_turnTimerRunning: true,
  m_impactThisTurn: true,
  m_firedThisTurn: true,
  m_tanksMoving: true,
  m_jetSounding: true,
  m_camera: true,
  m_crateField: true,
  m_markers: true,
  m_netMode: true,
  m_netShotResolving: true,
  m_onNetTurnEnd: true,
  beginTurn: true,
  endTurn: true,
  updateBattle: true,
  endBattleIfDecided: true,
  economyFor: true,
  executeBotTurn: true,
  botAimAndFire: true,
  botMove: true,
  cameraFollowX: true,
  crateEnv: true,
  addCrate: true,
  collectCrate: true,
  creditDamage: true,
  settleMines: true,
  armShotClock: true,
  startTankMove: true,
  executeSentryTurn: true,
  fire: true,
  awardKillCredit: true,
  handleTankDestroyed: true,
};

export const LAND_KEYS: Record<keyof LandPriv, true> = {
  m_arrHeights: true,
  m_pixels: true,
  m_material: true,
  m_layers: true,
  m_nWidth: true,
  m_nHeight: true,
  m_spoil: true,
  m_radSpecks: true,
  m_radParticles: true,
  m_rngState: true,
  m_radGlowCanvas: true,
  m_radGlowX: true,
  m_radGlowY: true,
  m_radSlotRGB: true,
};

const cast = <T>(o: unknown): T => o as T;

// These views are PRIVATES-ONLY, deliberately. An intersection (`CGameController & GCPriv`) reads
// better and was tried first, but TypeScript reduces it to `never`: the members are `private` on
// the class and public here, which is a real conflict. So a test that needs both keeps the original
// reference for the public API and takes a view for the internals:
//     gc.startGame(2);            // public
//     priv(gc).m_tanks[0];        // internals

/** Soft-private view of a controller. */
export const priv = (gc: CGameController): GCPriv => cast<GCPriv>(gc);
/** Soft-private view of the terrain. */
export const landPriv = (land: CLand): LandPriv => cast<LandPriv>(land);
/** Soft-private view of a tank. */
export const tankPriv = (tank: CTank): TankPriv => cast<TankPriv>(tank);
/** Soft-private view of the net-game bridge. */
export const netPriv = (ng: object): NetGamePriv => cast<NetGamePriv>(ng);
/** Soft-private view of the particle system. */
export const particlesPriv = (ps: CParticleSystem): ParticlesPriv => cast<ParticlesPriv>(ps);
