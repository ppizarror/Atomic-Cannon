/**
 * Swept (continuous) collision: the integrator takes one full Euler step per frame, which on big maps
 * can span 35-50px vs a ~16px tank hit radius. The old endpoint point-sample let a shot whose path
 * crossed a tank skip clean over it ("I hit it dead-on, nothing happened"). weaponFlyStep now walks
 * the segment prev→cur and detonates at the first contact, snapping the blast onto it.
 */
import {describe, it, expect} from 'vitest';
import {Vec2} from '../src/math/Vec2';
import {CShot} from '../src/core/CShot';
import type {CTank} from '../src/core/CTank';
import {getWeapon} from '../src/core/CWeapon';
import {weaponFlyStep} from '../src/core/weapons/WeaponBehavior';
import type {ShotWorld} from '../src/core/weapons/WeaponBehavior';

const shell = () => getWeapon(0); // basic ballistic (default case)

function worldWithTank(cx: number, cy: number, r = 16): ShotWorld {
  const tank = {
    isAlive: () => true,
    distanceTo: (x: number, y: number) => Math.hypot(x - cx, y - cy),
    getHitRadius: () => r,
  } as unknown as CTank;
  return {
    land: {getHeightAt: () => 10_000, width: 4000, height: 2000}, // surface far below → no terrain hit
    tanks: [tank],
    blastScale: 1,
    random: () => 0,
  } as unknown as ShotWorld;
}

// Build a shot with a controlled segment: initFromVelocity seeds prevPos at `from`, then setPosition
// moves the endpoint to `to` without disturbing prevPos — exactly the prev→cur segment of one frame.
function sweptShot(from: Vec2, to: Vec2): CShot {
  const shot = new CShot();
  shot.initFromVelocity(from, 0, 0, 50, 50, null);
  shot.setPosition(to.x, to.y);
  return shot;
}

describe('swept collision (CCD)', () => {
  it('a fast shot whose path crosses a tank detonates on it (no tunneling)', () => {
    const world = worldWithTank(500, 300);
    // 60px horizontal step straight through the tank; the endpoint (530) is 30px away → the old point
    // test at the endpoint alone would MISS (30 > 16).
    const shot = sweptShot(new Vec2(470, 300), new Vec2(530, 300));

    expect(weaponFlyStep(shot, shell(), world, 1 / 60)).toBe('detonate');
    // Snapped onto the tank so the blast is a direct hit, not a step beyond it.
    expect(Math.abs(shot.getPosition().x - 500)).toBeLessThan(16);
  });

  it('a shot that never comes near the tank keeps flying', () => {
    const world = worldWithTank(500, 300);
    const shot = sweptShot(new Vec2(470, 100), new Vec2(530, 100)); // 200px above the tank

    expect(weaponFlyStep(shot, shell(), world, 1 / 60)).toBe('continue');
  });

  it('still registers an ordinary endpoint hit', () => {
    const world = worldWithTank(500, 300);
    const shot = sweptShot(new Vec2(496, 300), new Vec2(500, 300)); // small step, ends on the tank

    expect(weaponFlyStep(shot, shell(), world, 1 / 60)).toBe('detonate');
  });
});
