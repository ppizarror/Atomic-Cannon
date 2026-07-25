/**
 * Rebounder/Seeker (EXT.REBOUND): on hitting terrain it jets up and out (anti-grav), then re-emerges
 * into open air, drops anti-grav, arcs back DOWN under gravity, and detonates on the next impact.
 * Regression: anti-grav used to latch forever → the shot flew off the (unbounded) top of the world
 * and idled ~10s to its lifetime cap, a dead turn that dealt no damage.
 */
import {describe, it, expect} from 'vitest';
import {CShot} from '../src/core/CShot';
import {CWeapon, WEAPON_DATABASE, getWeapon} from '../src/core/CWeapon';
import {EXT, weaponFlyStep} from '../src/core/weapons/WeaponBehavior';
import type {ShotWorld} from '../src/core/weapons/WeaponBehavior';

const SURF = 300; // flat terrain surface Y
const world = {
  land: {getHeightAt: () => SURF, width: 1000, height: 600},
  tanks: [],
  blastScale: 1,
  random: () => 0,
} as unknown as ShotWorld;

const rebounder = (): CWeapon => {
  const i = WEAPON_DATABASE.findIndex((_, idx) => getWeapon(idx).getExtType() === EXT.REBOUND);
  return getWeapon(i);
};

describe('Rebounder flight', () => {
  it('jets out on the first dip, then arcs back down and detonates on the next impact', () => {
    const w = rebounder();
    const shot = new CShot();
    shot.setPosition(500, SURF - 50); // airborne, above the surface

    // 1) In open air, before any contact — keeps flying, no anti-grav yet.
    expect(weaponFlyStep(shot, w, world, 1 / 60)).toBe('continue');
    expect(shot.isAntiGrav()).toBe(false);

    // 2) Dips into terrain — latches anti-grav to jet up and out (does NOT detonate).
    shot.setPosition(500, SURF + 10);
    expect(weaponFlyStep(shot, w, world, 1 / 60)).toBe('continue');
    expect(shot.isAntiGrav()).toBe(true);
    expect(shot.hasRebounded()).toBe(false);

    // 3) Re-emerges into open air — anti-grav clears (gravity restored) and it is marked rebounded.
    shot.setPosition(500, SURF - 30);
    expect(weaponFlyStep(shot, w, world, 1 / 60)).toBe('continue');
    expect(shot.isAntiGrav()).toBe(false);
    expect(shot.hasRebounded()).toBe(true);

    // 4) Arcs back down into terrain — now it detonates (before the fix it flew up forever).
    shot.setPosition(500, SURF + 10);
    expect(weaponFlyStep(shot, w, world, 1 / 60)).toBe('detonate');
  });
});
