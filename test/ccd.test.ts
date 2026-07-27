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
import {getWeapon, getDefaultWeaponIndex} from '../src/core/CWeapon';
import {EXT, weaponFlyStep} from '../src/core/weapons/WeaponBehavior';
import type {ShotWorld} from '../src/core/weapons/WeaponBehavior';

// The unlimited staple — a plain ballistic shell that goes through weaponFlyStep's DEFAULT case
// (not a beam/digger/etc), so the terrain-vs-tank ordering below actually exercises that path.
const shell = () => getWeapon(getDefaultWeaponIndex());

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

function mockTank(cx: number, cy: number, r = 16): CTank {
  return {
    isAlive: () => true,
    distanceTo: (x: number, y: number) => Math.hypot(x - cx, y - cy),
    getHitRadius: () => r,
  } as unknown as CTank;
}

function worldOf(tanks: CTank[], getHeightAt: (x: number) => number = () => 10_000): ShotWorld {
  return {
    land: {getHeightAt, width: 4000, height: 2000},
    tanks,
    blastScale: 1,
    random: () => 0,
  } as unknown as ShotWorld;
}

// Build a shot with a controlled segment: initFromVelocity seeds prevPos at `from`, then setPosition
// moves the endpoint to `to` without disturbing prevPos — exactly the prev→cur segment of one frame.
function sweptShot(from: Vec2, to: Vec2, owner: CTank | null = null): CShot {
  const shot = new CShot();
  shot.initFromVelocity(from, 0, 0, 50, 50, owner); // m_leftOwner defaults false (not yet armed vs owner)
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

describe('owner self-hit arming (regression: swept test near the muzzle)', () => {
  it('a shot does NOT detonate on its own tank while still near the muzzle (un-armed)', () => {
    const owner = mockTank(500, 300);
    // Segment stays inside the owner's 16px radius — as at the barrel on a low-power / down-slope shot.
    const shot = sweptShot(new Vec2(500, 288), new Vec2(500, 292), owner);
    expect(weaponFlyStep(shot, shell(), worldOf([owner]), 1 / 60)).toBe('continue'); // no self-detonation
  });

  it('the SAME geometry detonates on an ENEMY tank — only the owner is spared', () => {
    const owner = mockTank(900, 300); // owner is elsewhere; the tank at the muzzle is an enemy
    const enemy = mockTank(500, 300);
    const shot = sweptShot(new Vec2(500, 288), new Vec2(500, 292), owner);
    expect(weaponFlyStep(shot, shell(), worldOf([enemy, owner]), 1 / 60)).toBe('detonate');
  });

  it('once the shot has cleared the owner it can hit it again (a rebounder returning)', () => {
    const owner = mockTank(500, 300);
    const shot = sweptShot(new Vec2(500, 288), new Vec2(500, 292), owner);
    (shot as unknown as {m_leftOwner: boolean}).m_leftOwner = true; // armed: it left the radius earlier
    expect(weaponFlyStep(shot, shell(), worldOf([owner]), 1 / 60)).toBe('detonate');
  });
});

describe('terrain-before-tank (regression: no shooting through a ridge)', () => {
  it('the staple used here is a default-case ballistic shell, not a beam', () => {
    expect(shell().getExtType()).not.toBe(EXT.BEAM);
  });

  it('detonates on the ridge it crosses first, not the tank sitting behind it', () => {
    const tankBehind = mockTank(560, 300, 16);
    // A ridge from x≥520 (surface y=290); elsewhere the ground is far below the shot.
    const world = worldOf([tankBehind], x => (x >= 520 ? 290 : 10_000));
    const shot = sweptShot(new Vec2(500, 295), new Vec2(570, 295)); // path crosses the ridge, then the tank

    expect(weaponFlyStep(shot, shell(), world, 1 / 60)).toBe('detonate');
    expect(shot.getPosition().x).toBeLessThan(544); // snapped onto the ridge (~522), before the tank (560±16)
  });
});
