/**
 * Ultra (level-11) AI planner — CBotUltraAI. The planner is pure, so these build an UltraCtx and
 * assert the chosen action: best expected-value shot (multi-hit aware), nuke reservation, and
 * purposeful movement (crate / radiation flee / reposition) and self-buff over a wasted shot.
 */
import {describe, it, expect} from 'vitest';

import {
  blastDamageToEnemy,
  bestOffensiveShot,
  planUltraTurn,
  type UltraCtx,
  type UltraWeapon,
  type UltraEnemy,
} from '../src/core/CBotUltraAI';
import type {AimField, Pt} from '../src/core/CBotAI';

const GY = 500; // flat ground line
const flat: AimField = {heightAt: () => GY, width: 1000, height: 620};

// A base weapon; override per test. Radius/innerR are already in on-screen px (caller folds scale).
function weapon(over: Partial<UltraWeapon>): UltraWeapon {
  return {
    index: 0, ext: 0, cost: 0, count: Infinity, damage: 60, radius: 30, innerR: 5, spread: 0,
    dotValue: 0, earth: 0, piercing: false, isBeam: false, isPremium: false, offensive: true, ...over,
  };
}
function enemy(over: Partial<UltraEnemy>): UltraEnemy {
  return {x: 700, y: GY - 10, life: 1000, maxLife: 1000, shield: 0, hitRadius: 14, ...over};
}

function ctx(over: Partial<UltraCtx>): UltraCtx {
  return {
    self: {x: 100, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false},
    enemies: [enemy({})],
    weapons: [weapon({})],
    crates: [],
    field: flat,
    wind: {x: 0, y: 0},
    gustT0: 0,
    muzzleFor: (_deg: number): Pt => ({x: 100, y: GY - 24}),
    aimDegToward: () => 0,
    moveMaxDist: 0,
    radiationAt: () => false,
    rnd: () => 0.99, // above TRICK_CHANCE → never take the random trick play (deterministic tests)
    ...over,
  };
}

describe('blastDamageToEnemy — two-radius model', () => {
  const w = weapon({damage: 100, radius: 60, innerR: 10});
  it('full inside the core, falls off to zero at the outer edge, nothing beyond', () => {
    expect(blastDamageToEnemy(700, GY, w, enemy({x: 700, y: GY}))).toBe(100); // dead centre → full
    const outer = 60 + 14;
    const far = blastDamageToEnemy(700, GY, w, enemy({x: 700 + outer + 5, y: GY})); // past outer
    expect(far).toBe(0);
    const mid = blastDamageToEnemy(700, GY, w, enemy({x: 740, y: GY})); // inside falloff band
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });
  it('a beam deals full damage anywhere within reach (no falloff)', () => {
    const beam = weapon({damage: 100, radius: 60, innerR: 10, isBeam: true});
    expect(blastDamageToEnemy(700, GY, beam, enemy({x: 745, y: GY}))).toBe(100);
  });
});

describe('bestOffensiveShot — expected value', () => {
  it('prefers the weapon that catches a CLUSTER (multi-hit) over a bigger single hit', () => {
    const enemies = [enemy({x: 700}), enemy({x: 745})]; // two tanks ~45px apart
    const small = weapon({index: 1, damage: 90, radius: 20}); // reaches only one
    const big = weapon({index: 2, damage: 60, radius: 120}); // reaches both
    const shot = bestOffensiveShot(ctx({enemies, weapons: [small, big]}));
    expect(shot?.weaponIndex).toBe(2); // the cluster-catcher wins…
    expect(shot?.hits).toBe(2); // …because it hits both
  });

  it('BANKS a nuke on a low-value shot — fires the cheap Shell instead', () => {
    const enemies = [enemy({x: 700, life: 1000})]; // lone, healthy → no kill available
    const shell = weapon({index: 0, damage: 60, radius: 30, cost: 0});
    const nuke = weapon({index: 9, damage: 500, radius: 150, cost: 800, isPremium: true});
    const shot = bestOffensiveShot(ctx({enemies, weapons: [shell, nuke]}));
    expect(shot?.weaponIndex).toBe(0); // premium reserved; cheap round chosen
  });

  it('SPENDS the nuke when only it secures a kill', () => {
    const enemies = [enemy({x: 700, life: 300})]; // Shell can't kill, nuke can
    const shell = weapon({index: 0, damage: 60, radius: 30, cost: 0});
    const nuke = weapon({index: 9, damage: 500, radius: 150, cost: 800, isPremium: true});
    const shot = bestOffensiveShot(ctx({enemies, weapons: [shell, nuke]}));
    expect(shot?.weaponIndex).toBe(9);
    expect(shot?.kills).toBe(1);
  });

  it('reaches for an AIRBURST (wide submunition spread) against a spread-out group', () => {
    const enemies = [enemy({x: 660}), enemy({x: 730}), enemy({x: 800})]; // ~70px apart
    const plain = weapon({index: 1, damage: 80, radius: 35, spread: 0}); // tight — catches one
    const airburst = weapon({index: 2, ext: 13, damage: 50, radius: 30, spread: 120}); // rains wide
    const shot = bestOffensiveShot(ctx({enemies, weapons: [plain, airburst]}));
    expect(shot?.weaponIndex).toBe(2); // the area weapon…
    expect(shot?.hits).toBe(3); // …blankets the whole group
  });

  it('values a GAS/DOT round above an equal direct hit (sustained damage)', () => {
    const enemies = [enemy({x: 700, life: 1000})];
    const plain = weapon({index: 1, damage: 60, radius: 30, dotValue: 0});
    const gas = weapon({index: 2, damage: 60, radius: 30, dotValue: 200}); // lingering fallout
    const shot = bestOffensiveShot(ctx({enemies, weapons: [plain, gas]}));
    expect(shot?.weaponIndex).toBe(2); // DOT makes it the higher-value round
  });
});

describe('planUltraTurn — purposeful action selection', () => {
  it('flees the fallout carpet when standing on it with no shot to take', () => {
    const plan = planUltraTurn(
      ctx({
        weapons: [], // nothing to fire
        self: {x: 100, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: true},
        moveMaxDist: 200,
        radiationAt: x => Math.abs(x - 100) < 50, // clean ground exists just off the carpet
      }),
    );
    expect(plan.action).toBe('move');
    if (plan.action === 'move') expect(plan.note).toBe('flee-radiation');
  });

  it('drives to grab a valuable credits crate on the far side (away from the enemy)', () => {
    // Crate at x=60 is AWAY from the enemy at x=700 (self at 100) → grabbing it keeps distance.
    const plan = planUltraTurn(
      ctx({weapons: [], crates: [{x: 60, kind: 'credits', amount: 2000, landed: true}], moveMaxDist: 300}),
    );
    expect(plan.action).toBe('move');
    if (plan.action === 'move') {
      expect(plan.destX).toBe(60);
      expect(plan.note).toBe('crate:credits');
    }
  });

  it('will NOT chase a crate that pulls it toward the enemy (keeps its distance)', () => {
    // Crate at x=400 sits between self (100) and enemy (700) → grabbing it closes distance → skipped.
    const plan = planUltraTurn(
      ctx({weapons: [], crates: [{x: 400, kind: 'credits', amount: 2000, landed: true}], moveMaxDist: 400}),
    );
    if (plan.action === 'move') expect(plan.note).not.toBe('crate:credits'); // not the crate
  });

  it('ignores a still-FALLING crate (waits for it to land) and shoots instead', () => {
    const plan = planUltraTurn(
      ctx({
        weapons: [weapon({damage: 60, radius: 30})],
        crates: [{x: 60, kind: 'credits', amount: 2000, landed: false}], // parachuting → not yet grabbable
        moveMaxDist: 300,
      }),
    );
    expect(plan.action).toBe('fire'); // no landed crate to grab → take the shot
  });

  it('never grabs a BOMB crate (it is a trap)', () => {
    const plan = planUltraTurn(
      ctx({weapons: [], crates: [{x: 60, kind: 'bomb', amount: 0, landed: true}], moveMaxDist: 300, enemies: [enemy({})]}),
    );
    // No shot, no real crate, not on radiation → falls back to reposition (never a bomb-crate move).
    if (plan.action === 'move') expect(plan.note).not.toBe('crate:bomb');
  });

  it('repositions toward the enemy when nothing can reach it', () => {
    const plan = planUltraTurn(
      ctx({
        enemies: [enemy({x: 5500})], // far out of range
        field: {heightAt: () => GY, width: 6000, height: 620},
        weapons: [weapon({damage: 60, radius: 30})],
        moveMaxDist: 250,
      }),
    );
    expect(plan.action).toBe('move');
    if (plan.action === 'move') {
      expect(plan.note).toBe('reposition');
      expect(plan.destX).toBeGreaterThan(100); // drove toward the far enemy
    }
  });

  it('self-heals when badly hurt and there is no offensive play', () => {
    const heal = weapon({index: 5, ext: 10, damage: 0, offensive: false, count: 1});
    const plan = planUltraTurn(
      ctx({
        weapons: [heal],
        self: {x: 100, y: GY - 24, life: 200, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false},
      }),
    );
    expect(plan.action).toBe('buff');
    if (plan.action === 'buff') expect(plan.weaponIndex).toBe(5);
  });

  it('takes a lethal shot over grabbing a crate', () => {
    const plan = planUltraTurn(
      ctx({
        enemies: [enemy({x: 700, life: 40})], // a kill is on the table
        weapons: [weapon({index: 0, damage: 60, radius: 30})],
        crates: [{x: 60, kind: 'credits', amount: 2000, landed: true}], // valuable, safe crate
        moveMaxDist: 300,
      }),
    );
    expect(plan.action).toBe('fire'); // the kill beats the crate
  });
});
