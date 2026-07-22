/**
 * Deterministic logic tests for the computer-player AI (CBotAI): the aim solver
 * must actually converge on a hit (flat ground, wind, and over a hill), and the
 * difficulty level must scale the aim error and steer target/weapon choice.
 */
import {describe, it, expect} from 'vitest';

import {
  bestAim,
  aimProbability,
  angleError,
  pickTarget,
  pickWeapon,
  ballisticWeaponIndices,
  moveWeaponIndices,
  pickMoveWeapon,
  simulateMiss,
  AI_LEVEL_MIN,
  AI_LEVEL_MAX,
  type AimField,
} from '../src/core/CBotAI';
import {WEAPON_DATABASE} from '../src/core/CWeapon';

const GY = 500; // flat ground line (screen-Y)
const flat: AimField = {heightAt: () => GY, width: 1000, height: 620};
// Muzzle a little above the ground at the tank's x (barrel shift ignored for tests).
const muzzleAt = (x: number) => () => ({x, y: GY - 24});
const noWind = {x: 0, y: 0};

describe('Bot AI', () => {
  it('aim converges on flat ground with no wind', () => {
    const target = {x: 700, y: GY - 10};
    const aim = bestAim(muzzleAt(180), target, noWind, flat);
    expect(aim.dist).toBeLessThan(20); // flat-ground solution is a near-hit
    // Re-simulating the solved shot reproduces the same small miss (physics match).
    const check = simulateMiss({x: 180, y: GY - 24}, aim.angleDeg, aim.power, noWind, flat, target);
    expect(Math.abs(check - aim.dist)).toBeLessThan(1e-6); // re-simulated shot matches the solve
  });

  it('aim works to the LEFT (angles past 90°) too', () => {
    const aim = bestAim(muzzleAt(820), {x: 300, y: GY - 10}, noWind, flat);
    expect(aim.dist).toBeLessThan(20); // leftward solution is a near-hit
    expect(aim.angleDeg).toBeGreaterThan(90); // leftward aim points left (90..180)
    expect(aim.angleDeg).toBeLessThan(180);
  });

  it('aim compensates for a strong crosswind', () => {
    const target = {x: 700, y: GY - 10};
    const wind = {x: 4, y: 0}; // pushes shots right
    const aim = bestAim(muzzleAt(180), target, wind, flat);
    expect(aim.dist).toBeLessThan(25); // windy solution is still a near-hit
  });

  it('aim arcs OVER a hill between the tank and the target', () => {
    const hill: AimField = {
      width: 1000,
      height: 620,
      heightAt: x => (x > 380 && x < 520 ? 250 : GY), // tall ridge in the middle
    };
    const aim = bestAim(muzzleAt(180), {x: 720, y: GY - 10}, noWind, hill);
    expect(aim.dist).toBeLessThan(30); // clears an intervening hill
  });

  it('difficulty model scales P(aim) and angle scatter', () => {
    expect(aimProbability(AI_LEVEL_MIN)).toBe(0); // P(aim) is 0 at level 0
    expect(aimProbability(AI_LEVEL_MAX)).toBe(1); // P(aim) is 1 at level 10
    expect(Math.abs(aimProbability(5) - 0.75)).toBeLessThan(1e-9); // P(aim) is 0.75 at level 5

    expect(angleError(AI_LEVEL_MAX, () => 1)).toBe(0); // no angle scatter at max level
    // Level 0 scatter magnitude is uniform in [2.0, 8.0]°; rnd=1 → the max, 8°.
    expect(Math.abs(Math.abs(angleError(AI_LEVEL_MIN, () => 1)) - 8)).toBeLessThan(1e-6); // level 0 scatter reaches 8°
    // Level 5 scatter is in [1.0, 4.0]°, strictly less than level 0's.
    expect(Math.abs(angleError(5, () => 1))).toBeLessThan(Math.abs(angleError(0, () => 1))); // scatter shrinks with level
    // Second roll < 0.5 flips the sign negative.
    expect(angleError(0, () => 0.2)).toBeLessThan(0); // scatter sign can be negative
  });

  it('target selection is deliberate only above level 7', () => {
    const enemies = [
      {x: 300, y: GY, healthFrac: 0.9}, // strong, near
      {x: 800, y: GY, healthFrac: 0.15}, // weak, far
    ];
    expect(pickTarget(enemies, 200, 10, () => 0.2)).toBe(1); // L>7, roll<0.4 → weakest
    expect(pickTarget(enemies, 200, 10, () => 0.5)).toBe(0); // L>7, 0.4≤roll<0.8 → nearest
    expect(pickTarget(enemies, 200, 5, () => 0.6)).toBe(1); // L≤7 always uses the random branch; floor(0.6*2)=1
  });

  it('weapon selection returns a valid ballistic weapon index', () => {
    const pool = new Set(ballisticWeaponIndices());
    expect(pool.size).toBeGreaterThan(0); // ballistic pool is non-empty
    let allValid = true;
    for (let i = 0; i < 40; i++) {
      const w = pickWeapon(1 + (i % AI_LEVEL_MAX));
      if (!pool.has(w)) allValid = false;
    }
    expect(allValid).toBe(true); // picked weapons are always in the ballistic pool
  });

  it('move utilities resolve (bot movement spends a turn on one of these)', () => {
    const moves = moveWeaponIndices();
    expect(moves).toHaveLength(3); // the three Move utilities resolve
    expect(
      moves.every(i => WEAPON_DATABASE[i].extType === 3 && WEAPON_DATABASE[i].type === 'Utility'),
    ).toBe(true); // Move utilities are extType-3 Utility weapons
    expect(moves).toContain(pickMoveWeapon(() => 0.5)); // pickMoveWeapon returns one of them
  });
});
