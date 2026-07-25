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
  rangePowerCorrection,
  ULTRA_PERSONALITIES,
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
    dotValue: 0, earth: 0, piercing: false, isBeam: false, isCleaner: false, isMine: false,
    isPremium: false, offensive: true, ...over,
  };
}
function enemy(over: Partial<UltraEnemy>): UltraEnemy {
  return {x: 700, y: GY - 10, life: 1000, maxLife: 1000, shield: 0, hitRadius: 14, buried: false, ...over};
}

function ctx(over: Partial<UltraCtx>): UltraCtx {
  return {
    self: {x: 100, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: false},
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
    mines: [],
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

  it('BANKS a nuke when a cheap Shell already does the job (both kill → cheaper wins)', () => {
    const enemies = [enemy({x: 700, life: 40})]; // a shell already finishes it
    const shell = weapon({index: 0, damage: 60, radius: 30, cost: 0});
    const nuke = weapon({index: 9, damage: 500, radius: 150, cost: 800, isPremium: true});
    const shot = bestOffensiveShot(ctx({enemies, weapons: [shell, nuke]}));
    expect(shot?.weaponIndex).toBe(0); // both kill → the cheap round wins, nuke banked
  });

  it('FIRES a nuke for BIG damage even without a kill (the leverage play)', () => {
    const enemies = [enemy({x: 700, life: 1000})]; // healthy — no one-shot kill, but a huge hit
    const shell = weapon({index: 0, damage: 60, radius: 30, cost: 0});
    const nuke = weapon({index: 9, damage: 500, radius: 150, cost: 800, isPremium: true});
    const shot = bestOffensiveShot(ctx({enemies, weapons: [shell, nuke]}));
    expect(shot?.weaponIndex).toBe(9); // 500 dmg ≫ shell → worth throwing to force the fight
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

  it('does NOT count a far overshoot as a hit (no phantom-fire loop)', () => {
    // A tank on a tall cliff the arc sails PAST: the shot lands far away, so no weapon "hits" it and
    // the planner must not report a shot (→ it will reposition/range instead of firing forever).
    const enemies = [enemy({x: 980, y: GY - 300})]; // high and near the right edge
    const shot = bestOffensiveShot(
      ctx({enemies, weapons: [weapon({damage: 60, radius: 30})], muzzleFor: () => ({x: 100, y: GY - 24})}),
    );
    // Either no shot at all, or one that genuinely lands on the target — never a phantom graze.
    if (shot) expect(shot.hits).toBeGreaterThan(0);
  });
});

describe('Ultra personalities — divergent play', () => {
  const shell = weapon({index: 0, damage: 60, radius: 30});
  const heal = weapon({index: 5, ext: 10, damage: 0, offensive: false, count: 1});

  it('cautious heals at 42% life where ruthless presses the attack', () => {
    const base = {
      enemies: [enemy({x: 700, life: 1000})],
      weapons: [shell, heal],
      self: {x: 100, y: GY - 24, life: 420, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: false},
    };
    const cautious = planUltraTurn(ctx({...base, weights: ULTRA_PERSONALITIES.cautious}));
    const ruthless = planUltraTurn(ctx({...base, weights: ULTRA_PERSONALITIES.ruthless}));
    expect(cautious.action).toBe('buff'); // heals when hurt (healBelow capped at 0.45 → 42% counts)
    expect(ruthless.action).toBe('fire'); // healBelow 0.40 → 42% is fine, so it presses
  });

  it('explores among near-best NON-kill shots (varies the weapon, no single-round spam)', () => {
    const enemies = [enemy({x: 700, life: 1000})]; // healthy → neither round kills
    const a = weapon({index: 1, damage: 80, radius: 40});
    const b = weapon({index: 2, damage: 90, radius: 40}); // slightly better, but close
    const picks = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const r = i / 40;
      const shot = bestOffensiveShot(
        ctx({enemies, weapons: [a, b], rnd: () => r, weights: {...ULTRA_PERSONALITIES.balanced, explore: 0.3}}),
      );
      if (shot) picks.add(shot.weaponIndex);
    }
    expect(picks.size).toBeGreaterThan(1); // both rounds see use — not always the top pick
  });

  it('a KILL is still taken deterministically (never explored away)', () => {
    const enemies = [enemy({x: 700, life: 40})]; // a kill is available
    const shell = weapon({index: 0, damage: 60, radius: 30});
    const other = weapon({index: 1, damage: 90, radius: 40});
    for (const r of [0.01, 0.5, 0.99]) {
      const shot = bestOffensiveShot(
        ctx({enemies, weapons: [shell, other], rnd: () => r, weights: {...ULTRA_PERSONALITIES.trickster, explore: 0.5}}),
      );
      expect(shot?.kills).toBe(1); // always a lethal shot regardless of the explore roll
    }
  });

  it('the personality profiles are genuinely distinct', () => {
    const {ruthless, cautious, trickster, balanced} = ULTRA_PERSONALITIES;
    expect(ruthless.premiumWaste).toBeLessThan(cautious.premiumWaste); // ruthless spends nukes freely
    expect(ruthless.healBelow).toBeLessThan(cautious.healBelow); // cautious heals earlier
    expect(trickster.trickChance).toBeGreaterThan(balanced.trickChance); // trickster loves setups
  });
});

describe('Ultra when BURIED', () => {
  const buriedSelf = {
    x: 100, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0,
    onRadiation: false, buried: true, threatened: false,
  };
  const beam = weapon({index: 5, isBeam: true, damage: 300, radius: 40});
  const cleaner = weapon({index: 7, isCleaner: true, damage: 0, offensive: false, count: 1});
  const shell = weapon({index: 0, damage: 60, radius: 30}); // normal ballistic → would self-damage

  it('will NOT fire a normal ballistic round (it would detonate in the dirt and hurt itself)', () => {
    const shot = bestOffensiveShot(ctx({self: buriedSelf, weapons: [shell]}));
    expect(shot).toBeNull(); // no safe (beam) firer → no offensive shot
  });

  it('digs itself out with a cleaner when there is no safe attack', () => {
    const plan = planUltraTurn(
      ctx({self: buriedSelf, weapons: [shell, cleaner], enemies: [enemy({x: 700, life: 1000})], moveMaxDist: 0}),
    );
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') {
      expect(plan.note).toBe('clean-self');
      expect(plan.weaponIndex).toBe(7); // the cleaner
    }
  });

  it('SHOOTS a low-life enemy with a beam instead of cleaning itself', () => {
    const plan = planUltraTurn(
      ctx({self: buriedSelf, weapons: [beam, cleaner], enemies: [enemy({x: 700, life: 40})], moveMaxDist: 0}),
    );
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') {
      expect(plan.weaponIndex).toBe(5); // the beam kill beats digging out
      expect(plan.note).not.toBe('clean-self');
    }
  });

  it('attacks with a beam (never a ballistic) while buried', () => {
    const shot = bestOffensiveShot(ctx({self: buriedSelf, weapons: [shell, beam], enemies: [enemy({x: 700})]}));
    expect(shot?.weaponIndex).toBe(5); // only the beam is considered
  });

  it('against a BURIED ENEMY prefers a beam over a nuke (a nuke would free it)', () => {
    const enemies = [enemy({x: 700, life: 1000, buried: true})];
    const nuke = weapon({index: 9, damage: 500, radius: 150, cost: 800, isPremium: true});
    const shot = bestOffensiveShot(ctx({weapons: [beam, nuke], enemies}));
    expect(shot?.weaponIndex).toBe(5); // beam pins it under the dirt; the nuke's crater would dig it out
  });
});

describe('Ultra pro tactics — mines & cover', () => {
  it('lays a MINE (area denial) when it holds one and has no better attack', () => {
    const mine = weapon({index: 8, ext: 16, isMine: true, offensive: false, damage: 100, count: 1});
    const plan = planUltraTurn(ctx({weapons: [mine], enemies: [enemy({x: 700})]}));
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') expect(plan.note).toBe('mine');
  });

  it('moves to COVER behind a ridge when threatened (the enemy has its range)', () => {
    const ridge: AimField = {heightAt: x => (x >= 380 && x <= 420 ? 200 : 500), width: 1000, height: 620};
    const plan = planUltraTurn(
      ctx({
        self: {x: 650, y: GY - 24, life: 800, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: true},
        enemies: [enemy({x: 700})],
        weapons: [], // nothing to fire → cover is the play
        field: ridge,
        moveMaxDist: 400,
      }),
    );
    expect(plan.action).toBe('move');
    if (plan.action === 'move') {
      expect(plan.note).toBe('cover');
      expect(plan.destX).toBeLessThan(380); // slipped behind the ridge, away from the enemy's arcs
    }
  });

  it('does NOT seek cover when not threatened', () => {
    const ridge: AimField = {heightAt: x => (x >= 380 && x <= 420 ? 200 : 500), width: 1000, height: 620};
    const plan = planUltraTurn(
      ctx({
        self: {x: 650, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: false},
        enemies: [enemy({x: 700})],
        weapons: [],
        field: ridge,
        moveMaxDist: 400,
      }),
    );
    if (plan.action === 'move') expect(plan.note).not.toBe('cover');
  });

  it('does NOT fire a beam THROUGH a hill (no line of sight)', () => {
    const hill: AimField = {heightAt: x => (x >= 400 && x <= 450 ? 150 : GY), width: 1000, height: 620};
    const beam = weapon({index: 5, isBeam: true, damage: 300, radius: 40});
    const shot = bestOffensiveShot(
      ctx({weapons: [beam], enemies: [enemy({x: 700, y: GY - 10})], field: hill, muzzleFor: () => ({x: 100, y: GY - 24})}),
    );
    expect(shot).toBeNull(); // the ridge blocks the ray → the beam is not a valid shot
  });

  it('does NOT lay a second mine when one already pins the enemy', () => {
    const mine = weapon({index: 8, ext: 16, isMine: true, offensive: false, damage: 100, count: 1});
    const plan = planUltraTurn(ctx({weapons: [mine], enemies: [enemy({x: 700})], mines: [710]}));
    if (plan.action === 'fire') expect(plan.note).not.toBe('mine'); // a mine's already there
  });

  it('does NOT take cover on a radiation spot, nor drive over a mine to it', () => {
    const ridge: AimField = {heightAt: x => (x >= 380 && x <= 420 ? 200 : 500), width: 1000, height: 620};
    const plan = planUltraTurn(
      ctx({
        self: {x: 650, y: GY - 24, life: 800, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: true},
        enemies: [enemy({x: 700})],
        weapons: [],
        field: ridge,
        moveMaxDist: 400,
        radiationAt: x => x < 380, // the only covered spots (behind the ridge) are irradiated
      }),
    );
    if (plan.action === 'move') expect(plan.note).not.toBe('cover'); // won't hide in fallout
  });

  it('does NOT reposition across a mine', () => {
    const plan = planUltraTurn(
      ctx({
        self: {x: 100, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: false},
        enemies: [enemy({x: 900})], // far → would reposition toward it…
        weapons: [],
        moveMaxDist: 400,
        mines: [300], // …but a mine sits on the path, so it won't
      }),
    );
    expect(plan.action).not.toBe('move'); // the only move (reposition) crosses the mine → skipped
  });
});

describe('Ultra desperation — low life', () => {
  const hurt = (life: number) =>
    ({x: 100, y: GY - 24, life, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: false});

  it('a badly hurt bot with a heal in stock HEALS instead of chipping', () => {
    const heal = weapon({index: 5, ext: 10, damage: 0, offensive: false, count: 1});
    const shell = weapon({index: 0, damage: 60, radius: 30});
    const plan = planUltraTurn(ctx({weapons: [shell, heal], enemies: [enemy({x: 700, life: 1000})], self: hurt(200)}));
    expect(plan.action).toBe('buff'); // the urgency curve makes healing beat a 60-dmg chip shot at 20% life
  });

  it('a desperate bot (low life, NO heal) throws a premium it would normally BANK', () => {
    const shell = weapon({index: 0, damage: 60, radius: 30, cost: 0});
    const premium = weapon({index: 9, damage: 200, radius: 40, cost: 800, isPremium: true}); // value 200 < 250 → normally banked
    const enemies = [enemy({x: 700, life: 1000})]; // healthy — no kill

    const calm = bestOffensiveShot(ctx({weapons: [shell, premium], enemies, self: hurt(1000)}));
    expect(calm?.weaponIndex).toBe(0); // full life → premium reserved, cheap Shell fired

    const plan = planUltraTurn(ctx({weapons: [shell, premium], enemies, self: hurt(200)}));
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') expect(plan.weaponIndex).toBe(9); // 20% life, no heal → do-or-die, throw it
  });
});

describe('rangePowerCorrection — walking shots onto target', () => {
  const opts = (over: Partial<Parameters<typeof rangePowerCorrection>[0]>) => ({
    selfX: 100, targetX: 700, lastPower: 500, landedX: 700, hitTol: 18, gain: 0.9, ...over,
  });

  it('overshoot → less power, undershoot → more, on-target → unchanged', () => {
    expect(rangePowerCorrection(opts({landedX: 820}))).toBeLessThan(500); // sailed past → ease off
    expect(rangePowerCorrection(opts({landedX: 560}))).toBeGreaterThan(500); // fell short → add power
    expect(rangePowerCorrection(opts({landedX: 705}))).toBe(500); // within hitTol → hold
  });

  it('firing LEFT flips the sign correctly (overshoot is past the target on the left)', () => {
    // self on the right (900), target on the left (300); landing at 180 overshoots to the left.
    expect(rangePowerCorrection(opts({selfX: 900, targetX: 300, landedX: 180}))).toBeLessThan(500);
  });

  it('converges onto the target within a few shots (range ∝ power²)', () => {
    // Toy physics: real landing = selfX + k·power² (a drift-free monotonic range model).
    const selfX = 100, targetX = 700, k = (targetX + 220 - selfX) / (500 * 500); // 500 power overshoots
    let power = 500;
    let landedX = selfX + k * power * power; // first shot overshoots to ~920
    expect(landedX).toBeGreaterThan(targetX + 100);
    for (let i = 0; i < 8; i++) {
      power = rangePowerCorrection({selfX, targetX, lastPower: power, landedX, hitTol: 8, gain: 0.9});
      landedX = selfX + k * power * power;
    }
    expect(Math.abs(landedX - targetX)).toBeLessThan(20); // walked onto the target
  });
});

describe('planUltraTurn — purposeful action selection', () => {
  it('flees the fallout carpet when HURT (survival) — one hop to clean ground', () => {
    const plan = planUltraTurn(
      ctx({
        weapons: [], // nothing to fire
        self: {x: 100, y: GY - 24, life: 250, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: true, buried: false, threatened: false},
        moveMaxDist: 200,
        radiationAt: x => Math.abs(x - 100) < 50, // clean ground exists just off the carpet
      }),
    );
    expect(plan.action).toBe('move');
    if (plan.action === 'move') expect(plan.note).toBe('flee-radiation'); // low life → flight beats all
  });

  it('a HEALTHY bot on radiation FIRES back instead of fleeing (eats a little DOT)', () => {
    const plan = planUltraTurn(
      ctx({
        weapons: [weapon({index: 0, damage: 150, radius: 40})], // a real shot
        enemies: [enemy({x: 700})],
        self: {x: 100, y: GY - 24, life: 1000, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: true, buried: false, threatened: false},
        moveMaxDist: 200,
        radiationAt: x => Math.abs(x - 100) < 50,
      }),
    );
    expect(plan.action).toBe('fire'); // full life → the shot outvalues a weak flee; it doesn't run
  });

  it('escapes radiation TOWARD a reachable crate — one move both flees and grabs the loot', () => {
    const plan = planUltraTurn(
      ctx({
        weapons: [],
        self: {x: 100, y: GY - 24, life: 300, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: true, buried: false, threatened: false},
        crates: [{x: 200, kind: 'credits', amount: 500, landed: true}], // clean ground + loot
        moveMaxDist: 300,
        radiationAt: x => Math.abs(x - 100) < 50, // x=200 is clean
      }),
    );
    expect(plan.action).toBe('move');
    if (plan.action === 'move') {
      expect(plan.note).toBe('flee-to-crate');
      expect(plan.destX).toBe(200); // heads to the box, off the carpet
    }
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
        self: {x: 100, y: GY - 24, life: 200, maxLife: 1000, shield: 0, armor: 0, hazmat: 0, credits: 0, onRadiation: false, buried: false, threatened: false},
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
