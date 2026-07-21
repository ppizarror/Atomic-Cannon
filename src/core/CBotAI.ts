/**
 * CBotAI — the computer players' aiming and decision-making.
 *
 * The hard part of artillery AI is the fire solution: what angle + power lands a
 * shot on a moving-terrain target with gravity AND wind in play. Rather than a
 * closed-form solve (which can't see hills in the way), we **simulate** candidate
 * shots with the exact projectile physics (`SHOT_*` from CShot) and search for the
 * arc that passes closest to the target — naturally flying over intervening
 * terrain. A coarse grid over (angle, power) finds the basin; a fine pass refines.
 *
 * Difficulty (`level`, higher = harder) then degrades that ideal aim: it adds a
 * random angle/power error that shrinks toward zero at the top level, and steers
 * target/weapon choice from "random" (easy) toward "best" (hard).
 */
import {SHOT_GRAVITY, SHOT_WIND_ACCEL, SHOT_SPEED_SCALE} from './CShot';
import {GameConfig} from './CGameConfig';
import {weaponEnabled} from './CGameContent';
import {WEAPON_DATABASE} from './CWeapon';
import {clamp, deg2rad} from '../math/num';

// Difficulty is a single 0..10 skill level (0 = "Dummy": never aims; 10 =
// "Einstein": perfect aim). 5 is a reasonable mid default.
export const AI_LEVEL_MIN = 0;
export const AI_LEVEL_MAX = 10;
export const AI_DEFAULT_LEVEL = 5;

// Aim search bounds (power in the game's 10..1000 scale; the sweep covers 100+).
const P_MIN = 100;
const P_MAX = 1000;
const COARSE_A = 5; // deg
const COARSE_P = 70; // power
const FINE_A = 1;
const FINE_P = 15;

export interface Pt {
  x: number;
  y: number;
}
export interface AimField {
  heightAt(x: number): number;
  width: number;
  height: number;
}
export interface AimResult {
  angleDeg: number;
  power: number;
  dist: number;
}

/**
 * Probability that the bot computes a FRESH firing solution this turn (vs. firing
 * with its stale aim). Rolls `rand%10 < level` twice and ORs them:
 * P = 1 − (1 − level/10)². L0→0%, L5→75%, L10→100%.
 */
export function aimProbability(level: number): number {
  const p = clamp(level / 10, 0, 1);
  return 1 - (1 - p) * (1 - p);
}

/**
 * Random angle scatter (degrees) added to the aim, scaling with how far the level
 * is below max. Magnitude is uniform in [0.2·(10−L), 0.8·(10−L)] with a random
 * sign; 0 at level ≥ 10. Power is never perturbed.
 */
export function angleError(level: number, rnd: () => number = Math.random): number {
  const span = Math.max(0, 10 - level);
  if (span === 0) return 0;
  const base = 0.8 * span;
  const floor = 0.2 * span;
  const mag = floor + (base - floor) * rnd();
  return (rnd() < 0.5 ? -1 : 1) * mag;
}

/**
 * Fly a virtual shot and return the closest distance it passes to `target`.
 * Uses the same semi-implicit Euler integrator as a real shot, so the aim it
 * finds transfers exactly. Stops on terrain contact or leaving the field.
 */
export function simulateMiss(
  origin: Pt,
  angleDeg: number,
  power: number,
  wind: Pt,
  field: AimField,
  target: Pt,
): number {
  const r = deg2rad(angleDeg);
  // Match the REAL launch physics exactly (incl. the √worldScale zoom) so the solver's
  // prediction stays accurate on scaled maps — otherwise bots would over/undershoot.
  const ws = Math.sqrt(GameConfig.worldScale);
  const speed = power * GameConfig.powerScale * ws;
  let vx = Math.cos(r) * speed;
  let vy = -Math.sin(r) * speed;
  let x = origin.x,
    y = origin.y;
  const dt = 1 / 30;
  let minD = Math.hypot(x - target.x, y - target.y);

  for (let i = 0; i < 500; i++) {
    vy += SHOT_GRAVITY * ws * dt;
    vx += wind.x * SHOT_WIND_ACCEL * ws * dt;
    vy += wind.y * SHOT_WIND_ACCEL * ws * dt;
    x += vx * dt;
    y += vy * dt;

    const d = Math.hypot(x - target.x, y - target.y);
    if (d < minD) minD = d;

    if (x < -40 || x > field.width + 40 || y > field.height + 60) break;
    if (y >= field.heightAt(clamp(x, 0, field.width - 1))) break; // hit ground
  }
  return minD;
}

/**
 * Search for the angle + power that lands nearest the target. `muzzleFor(deg)` is
 * the barrel-tip position for a given aim (so the launch point is exact). Fires on
 * the target's side of the tank; returns the best arc found.
 */
export function bestAim(
  muzzleFor: (deg: number) => Pt,
  target: Pt,
  wind: Pt,
  field: AimField,
): AimResult {
  const up = muzzleFor(90);
  const aimRight = target.x >= up.x;
  const loA = aimRight ? 8 : 98;
  const hiA = aimRight ? 82 : 172;

  let best: AimResult = {angleDeg: aimRight ? 45 : 135, power: 500, dist: Infinity};

  const scan = (a0: number, a1: number, aStep: number, p0: number, p1: number, pStep: number) => {
    for (let a = a0; a <= a1; a += aStep) {
      const o = muzzleFor(a);
      for (let p = p0; p <= p1; p += pStep) {
        if (p < P_MIN || p > P_MAX) continue;
        const d = simulateMiss(o, a, p, wind, field, target);
        if (d < best.dist) best = {angleDeg: a, power: p, dist: d};
      }
    }
  };

  scan(loA, hiA, COARSE_A, P_MIN, P_MAX, COARSE_P); // coarse basin
  scan(
    best.angleDeg - COARSE_A,
    best.angleDeg + COARSE_A,
    FINE_A, // refine
    best.power - COARSE_P,
    best.power + COARSE_P,
    FINE_P,
  );
  return best;
}

/**
 * Choose whom to shoot. Only high-skill bots (level > 7) target deliberately: a
 * 40% / 40% / 20% split between the weakest enemy, the nearest enemy, and a random
 * one. Every other level picks a uniformly random enemy.
 */
export function pickTarget(
  enemies: {x: number; y: number; healthFrac: number}[],
  botX: number,
  level: number,
  rnd: () => number = Math.random,
): number {
  if (enemies.length === 0) return -1;
  if (enemies.length === 1) return 0;

  if (level > 7) {
    const r = rnd();
    if (r < 0.4) {
      // weakest (lowest health)
      let best = 0;
      for (let i = 1; i < enemies.length; i++)
        if (enemies[i].healthFrac < enemies[best].healthFrac) best = i;
      return best;
    }
    if (r < 0.8) {
      // nearest
      let best = 0,
        bestD = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        const d = Math.abs(enemies[i].x - botX);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }
    // else fall through to random
  }
  return Math.floor(rnd() * enemies.length);
}

/** Indices of the Move utilities (Move Near/Mid/Far), in range order. */
export function moveWeaponIndices(): number[] {
  return ['Move Near', 'Move Mid', 'Move Far']
    .map(n => WEAPON_DATABASE.findIndex(w => w.name === n))
    .filter(i => i >= 0);
}

/** Pick a random Move utility to spend a turn moving, or -1 if none exist. */
export function pickMoveWeapon(rnd: () => number = Math.random): number {
  const idxs = moveWeaponIndices();
  return idxs.length ? idxs[Math.floor(rnd() * idxs.length)] : -1;
}

/** Indices of weapons a bot can aim as a simple ballistic arc (damage on impact). */
export function ballisticWeaponIndices(): number[] {
  const ok = new Set(['Shell', 'Bomb', 'Rocket', 'Missile', 'NUKE', 'Organic', 'DOT']);
  return WEAPON_DATABASE.filter(
    w => ok.has(String(w.type)) && w.damage > 0 && weaponEnabled(w.index),
  ).map(w => w.index);
}

/**
 * Choose a weapon to fire: a random ballistic round, except a level-8+ bot has a
 * 70% chance to grab its highest-"power" (damage) weapon instead (the
 * `level>8 && rand%100<70` upgrade).
 */
export function pickWeapon(level: number, rnd: () => number = Math.random): number {
  const pool = ballisticWeaponIndices();
  if (pool.length === 0) return 0;
  if (level > 8 && rnd() < 0.7) {
    let best = pool[0];
    for (const i of pool) if (WEAPON_DATABASE[i].damage > WEAPON_DATABASE[best].damage) best = i;
    return best;
  }
  return pool[Math.floor(rnd() * pool.length)];
}
