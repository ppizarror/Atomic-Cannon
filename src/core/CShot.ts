/**
 * CShot - Projectile Class
 */

import {Vec2} from '../math/Vec2';
import {CTank} from './CTank';
import {GameConfig} from './CGameConfig';
import {windProfile, isRealisticWind} from './wind';
import {TWO_PI, lerp} from '../math/num';

// ==========================================================================
// TUNING
//
// Trajectory constants — the single source of truth, shared with the aim AI so a
// simulated shot matches a real one exactly. Calibrated to our px/second space,
// preserving the ratios between gravity, launch speed and wind.
// ==========================================================================

export const SHOT_GRAVITY = 500; // px/s^2 downward
export const SHOT_WIND_ACCEL = 15; // wind display units -> px/s^2 of sideways drift
export const SHOT_SPEED_SCALE = 1; // launch speed per unit power
// Quadratic air drag, REALISTIC wind model only: a shot loses `SHOT_DRAG_K · speed` of its velocity
// per second, so faster/longer shots bleed more energy and the far end of the arc flattens (a real
// shell decelerates). 0.0002 → ~10%/s at 500 px/s, ~20%/s at 1000 px/s. Shared with the aim AI so
// bot predictions stay exact. Linear mode = 0 (drag-free ballistics, the classic feel).
export const SHOT_DRAG_K = 0.0002;

// Reference-engine → our-engine time conversion for weapon fields measured in the
// original's ballistic time-step (batSec, sucSec). Those fields count the SAME step
// that integrates gravity/velocity, so a duration in reference units maps to our
// seconds by the ratio of the two ballistic time-constants τ = launch-speed-per-power
// ÷ gravity. Both engines' launch coefficients carry a map-scale factor that cancels,
// leaving τ_ours / τ_ref with no invented number:
//   τ_ref  = (refPowerScale · refK) / refGravity = (1.5 · 0.1) / 4.9
//   τ_ours = SHOT_SPEED_SCALE / SHOT_GRAVITY
export const REF_TIME_SCALE = SHOT_SPEED_SCALE / SHOT_GRAVITY / ((1.5 * 0.1) / 4.9); // ≈ 0.065

// Reference view width for the resolution-normalised launch speed. The world is sized in DISPLAY
// pixels, so without this a fixed px/s launch speed reaches a shrinking fraction of the world as the
// screen widens. `launchSpeed` multiplies by √(viewWidth / LAUNCH_REF_WIDTH), so max power (1000)
// reaches ~2× the world width at 1× land size on EVERY resolution (it "easily passes the other end",
// matching the original — where power/gravity were in a fixed reference space, not display pixels).
// Lower this to make max power overshoot even more; raise it for a tighter max range.
export const LAUNCH_REF_WIDTH = 1000;

/**
 * Muzzle speed for a shot of the given power — the SINGLE source of truth shared by real
 * shots (init/initFromTank), cluster submunitions (WeaponBehavior) and the aim AI (CBotAI),
 * so a simulated shot matches a real one exactly. Reads GameConfig live (incl. the
 * √worldScale zoom) so scaled maps stay consistent.
 */
export function launchSpeed(power: number): number {
  // × √worldScale: the map-size zoom (landSize), same as gravity/wind below. × √(viewWidth/REF):
  // resolution normalisation, so max-power range is a consistent multiple of the world width at
  // any display size (fixes "power 1000 can't cross the map" on wide/ultrawide screens).
  return (
    power *
    SHOT_SPEED_SCALE *
    GameConfig.powerScale *
    Math.sqrt(GameConfig.worldScale) *
    Math.sqrt(GameConfig.viewWidth / LAUNCH_REF_WIDTH)
  );
}

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

interface TrailPoint {
  x: number;
  y: number;
  age: number;
}

// ==========================================================================
// CShot CLASS
// ==========================================================================

export class CShot {
  private static GRAVITY = SHOT_GRAVITY;
  private static WIND_ACCEL = SHOT_WIND_ACCEL; // wind display units -> px/s^2 of drift

  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================

  constructor() {
    this.m_pos = new Vec2(0, 0);
    this.m_vel = new Vec2(0, 0);
    this.m_owner = null;
    this.m_damage = 0;
    this.m_radius = 50;
    this.m_power = 50;
    this.m_bIsDead = false;
    this.m_bTrailActive = true;
    this.m_trailPoints = [];
    this.m_maxTrailAge = 0.5;
    this.m_maxTrailPoints = 20;
  }

  init(
    pos: Vec2,
    angleDegrees: number,
    power: number,
    damage: number,
    radius: number,
    owner?: CTank | null,
  ): void {
    this.m_pos = pos.clone();
    this.m_owner = owner || null;
    this.m_damage = damage;
    this.m_radius = radius;
    this.m_power = power;

    const fRadAngle = -((angleDegrees / 180) * Math.PI);
    const speed = launchSpeed(power);

    this.m_vel.x = Math.cos(fRadAngle) * speed;
    this.m_vel.y = Math.sin(fRadAngle) * speed;

    this.m_prevX = this.m_pos.x; // seed the swept-collision segment (no bogus frame-1 sweep)
    this.m_prevY = this.m_pos.y;
    this.m_bIsDead = false;
    this.m_trailPoints = [];
    this.addTrailPoint();
  }

  initFromTank(
    muzzlePos: Vec2,
    turretAngleRad: number,
    power: number,
    damage: number,
    radius: number,
    owner: CTank,
  ): void {
    this.m_pos = muzzlePos.clone();
    this.m_owner = owner;
    this.m_damage = damage;
    this.m_radius = radius;
    this.m_power = power;
    const speed = launchSpeed(power);

    // Unified aim: θ measured CCW from horizontal-right, screen-Y down → up = -sin.
    // Works for every direction, including below-horizon (negative) angles.
    this.m_vel.x = Math.cos(turretAngleRad) * speed;
    this.m_vel.y = -Math.sin(turretAngleRad) * speed;

    this.m_prevX = this.m_pos.x; // seed the swept-collision segment (no bogus frame-1 sweep)
    this.m_prevY = this.m_pos.y;
    this.m_bIsDead = false;
    this.m_trailPoints = [];
    this.addTrailPoint();
  }

  /** Spawn with an explicit velocity — used for cluster submunitions. */
  initFromVelocity(
    pos: Vec2,
    vx: number,
    vy: number,
    damage: number,
    radius: number,
    owner: CTank | null,
  ): void {
    this.m_pos = pos.clone();
    this.m_vel = new Vec2(vx, vy);
    this.m_owner = owner || null;
    this.m_damage = damage;
    this.m_radius = radius;
    this.m_prevX = this.m_pos.x; // seed the swept-collision segment (no bogus frame-1 sweep)
    this.m_prevY = this.m_pos.y;
    this.m_bIsDead = false;
    this.m_trailPoints = [];
    this.addTrailPoint();
  }

  // ========================================================================
  // SIMULATION
  // ========================================================================

  /**
   * Semi-implicit Euler step: gravity + wind added as acceleration, then position
   * advances. Beam-type shots skip gravity so they fly straight.
   *
   * `groundAt(x)` (optional) supplies the terrain surface height beneath the shot so the
   * shared wind PROFILE (core/wind.ts) can attenuate the drift near the ground in Realistic
   * mode — a shot skimming a hill barely feels the wind, the top of a tall arc gets it all.
   * In Linear mode (default) the profile is a constant 1, so wind is uniform as before; the
   * aim AI (CBotAI.simulateMiss) applies the identical profile so bot shots stay accurate.
   */
  update(dt: number, wind: Vec2, groundAt?: (x: number) => number): void {
    if (this.m_bIsDead) return;

    this.m_prevY = this.m_pos.y;
    this.m_prevX = this.m_pos.x;

    // Arm against the OWNER: a shot may not detonate on the tank that fired it until it has cleared
    // that tank's hit radius. Checked on the START-of-frame position (before advancing) so the frame
    // it crosses OUT still can't self-hit near the barrel — the swept collision runs after this and
    // samples from the muzzle outward. Without it a low-power / down-slope shot self-detonates the
    // instant it fires (the muzzle sits inside the owner's 16px radius). A rebounder that comes back
    // can still hit the owner (already armed); a Death round's blast still catches the firer.
    if (
      !this.m_leftOwner &&
      this.m_owner &&
      this.m_owner.distanceTo(this.m_pos.x, this.m_pos.y) >= this.m_owner.getHitRadius()
    ) {
      this.m_leftOwner = true;
    }

    // Gravity + wind scale with the world (√worldScale) exactly like the launch speed, so the
    // whole trajectory is one uniform physics zoom — a full-power shot keeps its reach and arc
    // shape on big maps instead of falling short. Flight time stays constant (speed & gravity
    // scale together).
    const ws = Math.sqrt(GameConfig.worldScale);
    // Rebound/jet shots invert gravity once they've dipped below the surface.
    const g = (this.m_antiGrav ? -CShot.GRAVITY : CShot.GRAVITY) * ws;
    this.m_vel.y += g * dt;
    // Wind altitude factor: 1 (uniform) in Linear mode; a 0-at-ground → 1-aloft ramp in Realistic.
    const wf = groundAt ? windProfile(groundAt(this.m_pos.x) - this.m_pos.y) : 1;
    this.m_vel.x += wind.x * CShot.WIND_ACCEL * ws * wf * dt;
    this.m_vel.y += wind.y * CShot.WIND_ACCEL * ws * wf * dt;

    // Air drag (Realistic model only): quadratic velocity bleed. Skipped for straight-flying
    // beam/no-gravity shots. Fractional loss per step = SHOT_DRAG_K · speed · dt.
    if (isRealisticWind()) {
      const speed = Math.hypot(this.m_vel.x, this.m_vel.y);
      const loss = SHOT_DRAG_K * speed * dt;
      this.m_vel.x -= this.m_vel.x * loss;
      this.m_vel.y -= this.m_vel.y * loss;
    }

    this.m_pos = new Vec2(this.m_pos.x + this.m_vel.x * dt, this.m_pos.y + this.m_vel.y * dt);
    this.m_movingDown = this.m_prevY < this.m_pos.y;
    this.m_age += dt;

    if (this.m_bTrailActive) {
      this.addTrailPoint();
      this.pruneTrailPoints(dt);
    }
  }

  // ========================================================================
  // PROJECTILE STATE & TRAIL
  // ========================================================================

  setAntiGrav(on: boolean): void {
    this.m_antiGrav = on;
  }

  isAntiGrav(): boolean {
    return this.m_antiGrav;
  }

  /** True once the shot has cleared its owner's hit radius — before this it can't detonate on the
   *  firing tank (prevents a muzzle-adjacent self-detonation; the swept collision consults it). */
  hasLeftOwner(): boolean {
    return this.m_leftOwner;
  }

  /** Rebounder state: true once the shot has jetted up out of terrain and is falling back down. */
  hasRebounded(): boolean {
    return this.m_rebounded;
  }

  setRebounded(on: boolean): void {
    this.m_rebounded = on;
  }

  // Kinematic accessors the weapon behaviours read/write (roller snap, apex test…).
  getVelocity(): Vec2 {
    return this.m_vel.clone();
  }

  setVelocity(vx: number, vy: number): void {
    this.m_vel = new Vec2(vx, vy);
  }

  setPosition(x: number, y: number): void {
    this.m_pos = new Vec2(x, y);
  }

  isMovingDown(): boolean {
    return this.m_movingDown;
  }

  getAge(): number {
    return this.m_age;
  }

  getPower(): number {
    return this.m_power;
  }

  setPower(p: number): void {
    this.m_power = p;
  }

  /** The FIRING shot's power, carried unchanged through cluster generations. Cluster submunitions
   *  launch at a flat 0.5× the original firing power at EVERY recursion depth (not 0.5× the parent
   *  submunition, which would compound), so a deep driller's chain stays evenly spaced. Falls back
   *  to this shot's own power (the firing shot itself), so gen-0 needs no explicit set. */
  getBasePower(): number {
    return this.m_basePower || this.m_power;
  }

  setBasePower(p: number): void {
    this.m_basePower = p;
  }

  kill(): void {
    this.m_bIsDead = true;
  }

  private addTrailPoint(): void {
    const pt: TrailPoint = {x: this.m_pos.x, y: this.m_pos.y, age: 0};
    this.m_trailPoints.push(pt);
    if (this.m_trailPoints.length > this.m_maxTrailPoints) {
      this.m_trailPoints.shift();
    }
  }

  private pruneTrailPoints(dt: number): void {
    for (const pt of this.m_trailPoints) {
      pt.age += dt;
    }

    this.m_trailPoints = this.m_trailPoints.filter(pt => pt.age < this.m_maxTrailAge);
  }

  // ========================================================================
  // COLLISION & POSITION
  // ========================================================================

  checkTankCollision(tank: CTank): boolean {
    if (!tank.isAlive()) return false;

    const dist = tank.distanceTo(this.m_pos.x, this.m_pos.y);
    return dist < tank.getHitRadius();
  }

  getPosition(): Vec2 {
    return this.m_pos.clone();
  }

  /** Position at the START of the current frame's step (before update() advanced it). The swept-
   *  collision test walks the segment prevPos→pos so a fast shot can't tunnel through a tank/ridge. */
  getPrevPosition(): Vec2 {
    return new Vec2(this.m_prevX, this.m_prevY);
  }

  /**
   * Where to DRAW the shot: a point on the segment the sim just stepped through, `alpha` of the way
   * from prevPos to pos. See {@link draw} for what alpha is and why this interpolates rather than
   * extrapolates. Anything that paints in step with the round (its edge-of-view tracking notch)
   * must go through this with the SAME alpha, or it drifts against the sprite it is pointing at.
   */
  renderPosition(alpha: number): Vec2 {
    return new Vec2(
      lerp(this.m_prevX, this.m_pos.x, alpha),
      lerp(this.m_prevY, this.m_pos.y, alpha),
    );
  }

  /** Exhaust point — the missile's REAR, where the trail/plume pours from. The trail
   *  emits here, not at the centre: it offsets back from the centre along the heading
   *  by half the on-screen sprite length, `0.5 × size × scale`. `size` = the weapon
   *  display size. */
  getExhaustPoint(size: number): Vec2 {
    const v = this.m_vel;
    const spd = Math.hypot(v.x, v.y);
    if (spd < 1e-3) return this.m_pos.clone();
    const half = 0.5 * size * GameConfig.tankSizeScale;
    return new Vec2(this.m_pos.x - (v.x / spd) * half, this.m_pos.y - (v.y / spd) * half);
  }

  isDead(): boolean {
    return this.m_bIsDead;
  }

  // ========================================================================
  // RENDERING
  // ========================================================================

  /**
   * `alpha` is the RENDER interpolation factor (see CGameController.renderAlpha): how far real time
   * has advanced from the previous fixed sim step toward the current one. The round is drawn at
   * `lerp(prevPos, pos, alpha)`, so a display refreshing faster than the 60 Hz sim gets a distinct
   * position every frame instead of each simulated one twice — without that, a shot on a 120 Hz
   * screen judders even at a rock-steady 120 fps. Default 1 = the raw sim position (what tests and
   * any non-interpolating caller get).
   *
   * Deliberately interpolates rather than extrapolates: the sprite renders up to one step in the
   * past (16.7 ms — imperceptible) but can never be drawn inside terrain the shot has not actually
   * reached and then snap back when the collision resolves.
   *
   * The heading is NOT interpolated — velocity turns by ~1° per step even at the apex, where it
   * turns fastest, so the extra state would buy nothing visible.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    color: string = '#ff8800',
    sprite: CanvasImageSource | null = null,
    size = 12,
    alpha = 1,
  ): void {
    if (this.m_bIsDead) return;

    const {x: rx, y: ry} = this.renderPosition(alpha);

    // Real projectile sprite, rotated to point along its velocity. Each round blits
    // so its LONGEST side spans `weapon.size × scale` px, aspect preserved, pivoted
    // at centre. `size` is the DISPLAY size — the BLAST radius
    // is the separate `radius` field — so a size-15 Stinger reads as a small missile
    // even though rocket.bmp is 32px wide.
    if (sprite) {
      const nw = (sprite as {width: number}).width;
      const nh = (sprite as {height: number}).height;
      const longest = Math.max(nw, nh);
      // Longest on-screen side = size × the shared sprite scale × Player Size; floor at
      // 2px so a tiny round still reads.
      const target = Math.max(2, size * GameConfig.tankSizeScale);
      const k = target / longest;
      const w = nw * k,
        h = nh * k;
      const ang = Math.atan2(this.m_vel.y, this.m_vel.x);
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(ang);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
      ctx.restore();
      return;
    }

    // Fallback glowing dot until the sprite is loaded.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(rx, ry, 4, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(rx, ry, 2, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }

  // ========================================================================
  // ACCESSORS & QUERIES
  // ========================================================================

  getDamage(): number {
    return this.m_damage;
  }

  getRadius(): number {
    return this.m_radius;
  }

  getOwner(): CTank | null {
    return this.m_owner;
  }

  // Which weapon fired this shot, and how deep in the cluster chain it is
  // (0 = the shot the player fired, 1 = its submunitions, ...).
  setWeaponIndex(i: number): void {
    this.m_weaponIndex = i;
  }

  getWeaponIndex(): number {
    return this.m_weaponIndex;
  }

  setGeneration(g: number): void {
    this.m_generation = g;
  }

  getGeneration(): number {
    return this.m_generation;
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================

  m_bIsDead: boolean;

  private m_pos: Vec2;
  private m_vel: Vec2;
  private m_owner: CTank | null;
  private m_damage: number;
  private m_radius: number;
  private m_power: number;
  private m_basePower = 0; // firing-shot power, propagated through cluster generations (0 → use m_power)
  private m_bTrailActive: boolean;
  private m_trailPoints: TrailPoint[];
  private m_maxTrailAge: number;
  private m_maxTrailPoints: number;
  private m_weaponIndex: number = -1;
  private m_generation: number = 0;
  private m_antiGrav: boolean = false;
  private m_rebounded: boolean = false;
  private m_leftOwner: boolean = false; // has the shot cleared its owner's hit radius (armed vs owner)?
  private m_prevY: number = 0;
  private m_prevX: number = 0;
  private m_movingDown: boolean = false;
  private m_age: number = 0;
  // Behaviour scratch: roller "grounded" latch, battery drop counter.
  grounded: boolean = false;
  batteryDrops: number = 0;
  batteryApex: number = -1; // age at first descent (battery drop cadence anchor); -1 = not yet
  digDepth: number = -1; // per-shot randomised digger bore depth (px); -1 = not yet chosen
  digEntryY: number = -1; // shot Y where it first went below the surface; -1 = not yet
  digCols: Set<number> | null = null; // columns already bored (each dug ONCE → trench backfills, no re-cave)
  // ---- HOMING (EXT.HOMING) ------------------------------------------------
  // Three phases, all keyed off the launch geometry captured in `homingSpanX`:
  // cruise → coast-down → apex relight, then powered guidance inside a fixed band.
  /** Predicted UNGUIDED horizontal range, captured on the first frame. The phase clock is
   *  progress along it, so "a quarter of the way out" means the same on every map. 0 = not set. */
  homingSpanX: number = 0;
  /** Launch position/velocity the phase profile is measured against. */
  homingX0: number = 0;
  homingVx0: number = 0;
  /** Upward speed the instant the motor cut. The brake is measured against it, so the horizontal
   *  speed reaches its floor exactly AT the apex (vy = 0) on every shot — keying the ramp to
   *  x-progress instead never finishes, because braking pulls the apex earlier than the unbraked
   *  range it was measured against. 0 = the motor has not cut yet. */
  homingVyCut: number = 0;
  /** Heading (deg) at the apex — the CENTRE of the ±band every later correction is measured from,
   *  so the missile can weave inside its authority without the band drifting with it. NaN until
   *  the apex, which is also the "guidance has not armed yet" test. */
  homingBase: number = Number.NaN;
  /** Commanded offset from `homingBase` (deg), re-solved during the descent, and how much of it
   *  the airframe has actually swung through so far — the gap between them is what it is turning. */
  homingAim: number = 0;
  homingApplied: number = 0;
  /** Tank the guidance is steering at, for the on-screen lock marker (null = coasting blind). */
  homingTarget: CTank | null = null;
  /** True on any frame the sustainer is lit. The exhaust plume reads this INSTEAD of the generic
   *  "burns until apex" rule, so a guided round smokes under power, goes dark through the coast,
   *  and smokes again once it relights — the profile is legible in the trail itself. */
  homingBurn: boolean = false;
  /** Set once the relight has been announced, so the motor barks at the apex and not every frame. */
  homingRelit: boolean = false;
  /** The reachable region, refreshed every few frames and drawn under the missile: the landing
   *  points across the authority band, plus the two EXTREME trajectories that bound them. The
   *  bounding paths are kept because the region has to be drawn along the real curves — chords
   *  from the missile to the landing points cut through any rising ground in between. */
  homingFan: {x: number; y: number}[] = [];
  homingFanL: {x: number; y: number}[] = [];
  homingFanR: {x: number; y: number}[] = [];
  homingFanAge: number = 0;
}
