/**
 * Homing Missile (EXT.HOMING) — a plain ballistic missile that, at its APEX, picks the enemy tank
 * nearest where it would otherwise land and eases a bounded course correction in while the
 * sustainer relights. What matters and is asserted here:
 *
 *   • guidance arms at the apex, never on the way up (a missile that steered from launch would be
 *     a drone, not a rocket);
 *   • the correction is EASED in, not snapped — the heading is still moving several frames later;
 *   • authority is bounded, so a wild shot cannot be rescued;
 *   • it will not steer onto a team-mate, and does nothing when no one is near the impact;
 *   • everything else is the ordinary ballistic path (it still detonates on terrain/tanks).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, getWeapon} from '../src/core/CWeapon';
import {CShot} from '../src/core/CShot';
import {CLand} from '../src/core/CLand';
import {CTank} from '../src/core/CTank';
import {Vec2} from '../src/math/Vec2';
import {weaponFlyStep, EXT, type ShotWorld} from '../src/core/weapons/WeaponBehavior';

const HOMING = WEAPON_DATABASE.find(w => w.id === 'homing.missile')!;
const DT = 1 / 60;

/** A flat world with whatever tanks a case needs. */
class World implements ShotWorld {
  land: CLand;
  tanks: CTank[] = [];
  blastScale = 1;
  wind = new Vec2(0, 0);

  constructor() {
    // Dead flat, so a prediction's landing point is unambiguous and every case is repeatable.
    this.land = new CLand(1600, 600);
    const h = new Int16Array(1600);
    h.fill(450);
    this.land.initFromArray(h, 1, 1);
  }

  random(): number {
    return 0.5;
  }
  spawnShot(): void {}
  explode(): void {}
  debrisSpray(): void {}
  shake(): void {}
  ripple(): void {}
  applyBlast(): void {}
  aimMarker(): void {}
  deployMine(): void {}
  deploySentry(): void {}
  hitSound(): void {}
}

/** A stand-in tank at (x, y) on `team`, with the real hit-radius/alive contract homing reads. */
function tankAt(x: number, y: number, team: number): CTank {
  return {
    isAlive: () => true,
    getPosition: () => new Vec2(x, y),
    getTeamId: () => team,
    getHitRadius: () => 16,
    distanceTo: (px: number, py: number) => Math.hypot(px - x, py - y),
  } as unknown as CTank;
}

/** A homing round launched up-and-right from (200, 440) — the same launch in every case, so the
 *  unguided impact point is a fixed baseline to place targets against. */
function launch(): CShot {
  const shot = new CShot();
  shot.init(new Vec2(200, 440), 45, 420, HOMING.damage, HOMING.radius, null);
  shot.setWeaponIndex(HOMING.index);
  return shot;
}

/** Fly until `stop` says so (or the shot resolves); returns the frames elapsed. */
function fly(shot: CShot, world: World, stop: (s: CShot) => boolean, max = 900): number {
  const weapon = getWeapon(HOMING.index);
  for (let i = 0; i < max; i++) {
    if (stop(shot)) return i;
    shot.update(DT, world.wind);
    if (weaponFlyStep(shot, weapon, world, DT) !== 'continue') return i;
  }
  return max;
}

const headingDeg = (s: CShot) => (Math.atan2(s.getVelocity().y, s.getVelocity().x) * 180) / Math.PI;

/** Where the same launch lands with nothing to steer toward — the baseline every case places its
 *  target relative to, since acquisition is measured from the UNGUIDED impact point. */
function unguidedImpactX(): number {
  const world = new World();
  const probe = launch();
  fly(probe, world, () => false);
  return probe.getPosition().x;
}

/** Fly to the apex, drop `target` into the world, then run the one frame that arms guidance. */
function armAt(world: World, shot: CShot): void {
  fly(shot, world, s => s.isMovingDown());
  shot.update(DT, world.wind);
  weaponFlyStep(shot, getWeapon(HOMING.index), world, DT);
}

describe('Homing Missile', () => {
  it('is a HOMING-behaviour Rocket in the data', () => {
    expect(getWeapon(HOMING.index).getExtType()).toBe(EXT.HOMING);
    // `type` is a LABEL — behaviour comes from `extType` alone. In this port the Missile label
    // has settled on the multi-rocket salvos (Katyusha, Strikers, Tomcat), so a single guided
    // round files under Rocket.
    expect(HOMING.type).toBe('Rocket');
    // One guided round, not a fan. Read through the getter: the row omits `spawn` because 1
    // is the engine default, so the raw record has no such key.
    expect(getWeapon(HOMING.index).getSpawnCount()).toBe(1);
  });

  it('reads its guidance limits from the weapon row, with defaults when absent', () => {
    // The knobs are per-weapon so a future seeker can simply be given a wider band or a finer
    // search — a smarter missile is a data change, not an engine change.
    const w = getWeapon(HOMING.index);
    expect(w.getHomingMaxTurn()).toBe(HOMING.homMaxDeg);
    expect(w.getHomingStep()).toBe(HOMING.homStepDeg);
    expect(w.getHomingFineStep()).toBe(HOMING.homFineDeg);
    // A row that declares none of them still behaves — every getter falls back.
    const plain = getWeapon(WEAPON_DATABASE.findIndex(x => x.id === 'rocket'));
    expect(plain.getHomingMaxTurn()).toBeGreaterThan(0);
    expect(plain.getHomingStep()).toBeGreaterThan(0);
    expect(plain.getHomingFineStep()).toBeGreaterThan(0);
  });

  it('does not steer while still climbing', () => {
    const world = new World();
    world.tanks = [tankAt(unguidedImpactX(), 450, 1)];
    const shot = launch();
    const weapon = getWeapon(HOMING.index);
    // Every frame of the CLIMB must leave guidance untouched — it may only arm once the round
    // tips over. Checked after the fly step, which is where it would have armed.
    let climbFrames = 0;
    for (let i = 0; i < 900; i++) {
      shot.update(DT, world.wind);
      const climbing = !shot.isMovingDown();
      if (weaponFlyStep(shot, weapon, world, DT) !== 'continue') break;
      if (!climbing) break;
      expect(Number.isNaN(shot.homingBase)).toBe(true); // guidance has not armed yet
      climbFrames++;
    }
    expect(climbFrames).toBeGreaterThan(20); // it really did spend a while climbing
  });

  it('acquires at the apex and eases the correction in over several frames', () => {
    const world = new World();
    // A tank off to the side of where the round would land unaided, but inside acquisition range,
    // so a real correction is both needed and possible.
    world.tanks = [tankAt(unguidedImpactX() + 180, 450, 1)];
    const shot = launch();

    fly(shot, world, s => s.isMovingDown());
    const before = headingDeg(shot);
    shot.update(DT, world.wind);
    weaponFlyStep(shot, getWeapon(HOMING.index), world, DT);
    expect(Number.isNaN(shot.homingBase)).toBe(false); // guidance armed at the apex
    expect(shot.homingTarget).not.toBeNull(); // and it found something to steer toward
    expect(Math.abs(shot.homingAim)).toBeGreaterThan(0); // with a real correction commanded

    // Eased, not snapped: one frame in, only a sliver of the correction has been applied.
    const afterOne = Math.abs(headingDeg(shot) - before);
    expect(afterOne).toBeLessThan(Math.abs(shot.homingAim) * 0.5);

    // …and the heading is still turning several frames later (the ease runs ~0.9s).
    const mid = headingDeg(shot);
    for (let i = 0; i < 12; i++) {
      shot.update(DT, world.wind);
      if (weaponFlyStep(shot, getWeapon(HOMING.index), world, DT) !== 'continue') break;
    }
    expect(Math.abs(headingDeg(shot) - mid)).toBeGreaterThan(0.1);
  });

  it('lands closer to the target than the same shot unguided', () => {
    const targetX = unguidedImpactX() + 180;
    const world = new World();
    world.tanks = [tankAt(targetX, 450, 1)];
    const shot = launch();
    fly(shot, world, () => false);
    // The whole point: guidance has to actually improve the miss, not merely wiggle the arc.
    expect(Math.abs(shot.getPosition().x - targetX)).toBeLessThan(180);
  });

  it('never bends further than its authority', () => {
    const world = new World();
    // Right at the edge of acquisition — far enough that the missile wants to turn hard, so the
    // clamp is what stops it rather than the target simply being easy to reach.
    world.tanks = [tankAt(unguidedImpactX() + 290, 450, 1)];
    const shot = launch();
    armAt(world, shot);
    expect(shot.homingTarget).not.toBeNull(); // it did acquire…
    // …and still refused to over-turn. The bound is the WEAPON's own `homMaxDeg`, so retuning the
    // row retunes this assertion with it rather than stranding a magic 15 here.
    expect(Math.abs(shot.homingAim)).toBeLessThanOrEqual(getWeapon(HOMING.index).getHomingMaxTurn());
  });

  it('ignores team-mates and empty ground', () => {
    // A tank right where it would land, but on the FIRER's team → no correction.
    const mates = new World();
    const owner = tankAt(200, 440, 3);
    const mateShot = new CShot();
    mateShot.init(new Vec2(200, 440), 45, 420, HOMING.damage, HOMING.radius, owner);
    mateShot.setWeaponIndex(HOMING.index);
    mates.tanks = [owner, tankAt(unguidedImpactX() + 120, 450, 3)]; // same team as the owner
    armAt(mates, mateShot);
    expect(mateShot.homingTarget).toBeNull(); // looked, found only a team-mate, steers nowhere

    // Nobody within acquisition range → also no correction.
    const empty = new World();
    const lone = launch();
    armAt(empty, lone);
    expect(lone.homingTarget).toBeNull();
  });

  it('still detonates like an ordinary missile', () => {
    const world = new World();
    world.tanks = [tankAt(900, 450, 1)];
    const shot = launch();
    const weapon = getWeapon(HOMING.index);
    let action = 'continue';
    for (let i = 0; i < 900 && action === 'continue'; i++) {
      shot.update(DT, world.wind);
      action = weaponFlyStep(shot, weapon, world, DT);
    }
    expect(action).toBe('detonate'); // it lands and blows up — no drone that flies forever
  });

  it('still arms for a target near the edge, even if the unguided arc would sail off', () => {
    // Declining on "the unguided arc lands off the field" would refuse exactly the shots
    // guidance exists to save — an enemy parked near the boundary that the
    // round would overshoot by a little. What decides it is whether a TARGET is reachable, not
    // where the round would have gone had nobody been there.
    const world = new World();
    const overshoot = unguidedImpactX() + 120;
    world.tanks = [tankAt(overshoot, 450, 1)];
    const shot = launch();
    armAt(world, shot);
    expect(shot.homingLost).toBe(false);
    expect(Number.isNaN(shot.homingBase)).toBe(false); // armed
    expect(shot.homingTarget).not.toBeNull();
  });

  it('acquires a target standing UPHILL of where the round lands', () => {
    // The shape from a real miss report: the round comes down near the enemy, but the enemy is a
    // long way ABOVE it on a rise. Measuring the acquisition range diagonally counts that height
    // against the tank and refuses the shot; the band corrects along the ground, so only the
    // horizontal gap is its business. 120 across and 500 up is ~514 diagonally — comfortably
    // outside the 300 radius measured that way, comfortably inside it measured along the ground.
    const world = new World();
    world.tanks = [tankAt(unguidedImpactX() + 120, 450 - 500, 1)];
    const shot = launch();
    armAt(world, shot);
    expect(shot.homingTarget).not.toBeNull(); // uphill is still in range
    expect(Number.isNaN(shot.homingBase)).toBe(false); // …and it armed

    // …while genuinely distant ground is still refused, so this widened nothing but the axis.
    const far = new World();
    far.tanks = [tankAt(unguidedImpactX() + 700, 450, 1)];
    const lone = launch();
    armAt(far, lone);
    expect(lone.homingTarget).toBeNull();
  });

  it('is opt-in and reachable in a real match', () => {
    expect(HOMING.disabled).toBe(true); // a port addition, so it starts switched off
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(2);
    gc.setWeaponTest(true);
    expect(() => gc.selectWeapon(HOMING.index)).not.toThrow();
  });
});
