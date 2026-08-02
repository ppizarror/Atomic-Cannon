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
  m_viewW: number;
  m_viewH: number;
  m_worldWidth: number;
  m_currentWeaponIndex: number;
  m_speedScale: number;
  m_turnElapsed: number;
  m_turnTimerRunning: boolean;
  m_impactThisTurn: boolean;
  m_firedThisTurn: boolean;
  m_tanksMoving: boolean;
  m_jetSounding: boolean;
  // ── extracted subsystems (see src/game/*) ──
  m_camera: {reset(): void; isDwelling(): boolean; isShaking(): boolean; x(): number};
  m_crateField: {list(): readonly {x: number; y: number; kind: string; weaponIndex: number}[]};
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
  addCrate(x: number, forced?: string): void;
  collectCrate(crate: unknown, tank: CTank): void;
  creditDamage(shooter: CTank | null, victim: CTank, lifeRemoved: number): void;
  settleMines(dt: number): void;
}

/** The CLand internals tests reach for (terrain buffers are the whole point of most land tests). */
export interface LandPriv {
  m_arrHeights: Int16Array;
  m_pixels: Uint32Array;
  m_material: Uint8Array;
  m_layers: unknown;
  m_nWidth: number;
  m_nHeight: number;
  m_spoil: {x: number; y: number; vx: number; vy: number; age: number}[];
  m_radSpecks: {x: number; y: number; r: number; g: number; b: number}[];
  m_radParticles: {x: number; y: number; r: number}[];
  m_rngState: number;
}

/** The CTank internals tests reach for. */
export interface TankPriv {
  m_bIsAlive: boolean;
  m_bExploded: boolean;
  m_bBuried: boolean;
  m_vVel: {x: number; y: number};
}

/** The CParticleSystem internals tests reach for. */
export interface ParticlesPriv {
  m_particles: unknown[];
  m_explosions: unknown[];
  m_craterVents: unknown[];
  m_spoil: unknown[];
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
  m_viewW: true,
  m_viewH: true,
  m_worldWidth: true,
  m_currentWeaponIndex: true,
  m_speedScale: true,
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
  addCrate: true,
  collectCrate: true,
  creditDamage: true,
  settleMines: true,
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
};

const cast = <T>(o: unknown): T => o as T;

/** Soft-private view of a controller. */
export const priv = (gc: CGameController): GCPriv => cast<GCPriv>(gc);
/** Soft-private view of the terrain. */
export const landPriv = (land: CLand): LandPriv => cast<LandPriv>(land);
/** Soft-private view of a tank. */
export const tankPriv = (tank: CTank): TankPriv => cast<TankPriv>(tank);
/** Soft-private view of the particle system. */
export const particlesPriv = (ps: CParticleSystem): ParticlesPriv => cast<ParticlesPriv>(ps);
