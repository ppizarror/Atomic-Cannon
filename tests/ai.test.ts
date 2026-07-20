/**
 * Deterministic logic tests for the computer-player AI (CBotAI): the aim solver
 * must actually converge on a hit (flat ground, wind, and over a hill), and the
 * difficulty level must scale the aim error and steer target/weapon choice.
 * Run: pnpm tsx tests/ai.test.ts   (or `pnpm test`)
 */
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

let pass = 0,
  fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

const GY = 500; // flat ground line (screen-Y)
const flat: AimField = {heightAt: () => GY, width: 1000, height: 620};
// Muzzle a little above the ground at the tank's x (barrel shift ignored for tests).
const muzzleAt = (x: number) => () => ({x, y: GY - 24});
const noWind = {x: 0, y: 0};

console.log('Bot AI');

// 1. Aim converges on flat ground with no wind — the solved arc lands ON the target.
{
  const target = {x: 700, y: GY - 10};
  const aim = bestAim(muzzleAt(180), target, noWind, flat);
  ok(
    'flat-ground solution is a near-hit',
    aim.dist < 20,
    `dist=${aim.dist.toFixed(1)} a=${aim.angleDeg} p=${aim.power}`,
  );
  // Re-simulating the solved shot reproduces the same small miss (physics match).
  const check = simulateMiss({x: 180, y: GY - 24}, aim.angleDeg, aim.power, noWind, flat, target);
  ok('re-simulated shot matches the solve', Math.abs(check - aim.dist) < 1e-6);
}

// 2. Aim works to the LEFT (angles past 90°) too.
{
  const aim = bestAim(muzzleAt(820), {x: 300, y: GY - 10}, noWind, flat);
  ok(
    'leftward solution is a near-hit',
    aim.dist < 20,
    `dist=${aim.dist.toFixed(1)} a=${aim.angleDeg}`,
  );
  ok(
    'leftward aim points left (90..180)',
    aim.angleDeg > 90 && aim.angleDeg < 180,
    `a=${aim.angleDeg}`,
  );
}

// 3. Aim compensates for a strong crosswind.
{
  const target = {x: 700, y: GY - 10};
  const wind = {x: 4, y: 0}; // pushes shots right
  const aim = bestAim(muzzleAt(180), target, wind, flat);
  ok('windy solution is still a near-hit', aim.dist < 25, `dist=${aim.dist.toFixed(1)}`);
}

// 4. Aim arcs OVER a hill sitting between the tank and the target.
{
  const hill: AimField = {
    width: 1000,
    height: 620,
    heightAt: x => (x > 380 && x < 520 ? 250 : GY), // tall ridge in the middle
  };
  const aim = bestAim(muzzleAt(180), {x: 720, y: GY - 10}, noWind, hill);
  ok(
    'clears an intervening hill',
    aim.dist < 30,
    `dist=${aim.dist.toFixed(1)} a=${aim.angleDeg} p=${aim.power}`,
  );
}

// 5. Difficulty model: P(aim) grows with level; angle scatter shrinks to 0 at max.
{
  ok('P(aim) is 0 at level 0', aimProbability(AI_LEVEL_MIN) === 0);
  ok('P(aim) is 1 at level 10', aimProbability(AI_LEVEL_MAX) === 1);
  ok(
    'P(aim) is 0.75 at level 5',
    Math.abs(aimProbability(5) - 0.75) < 1e-9,
    `${aimProbability(5)}`,
  );

  ok('no angle scatter at max level', angleError(AI_LEVEL_MAX, () => 1) === 0);
  // Level 0 scatter magnitude is uniform in [2.0, 8.0]°; rnd=1 → the max, 8°.
  ok(
    'level 0 scatter reaches 8°',
    Math.abs(Math.abs(angleError(AI_LEVEL_MIN, () => 1)) - 8) < 1e-6,
    `${angleError(AI_LEVEL_MIN, () => 1)}`,
  );
  // Level 5 scatter is in [1.0, 4.0]°, strictly less than level 0's.
  ok(
    'scatter shrinks with level',
    Math.abs(angleError(5, () => 1)) < Math.abs(angleError(0, () => 1)),
  );
  // Second roll < 0.5 flips the sign negative.
  ok('scatter sign can be negative', angleError(0, () => 0.2) < 0, `${angleError(0, () => 0.2)}`);
}

// 6. Target selection: only level>7 aims deliberately; below that it's random.
{
  const enemies = [
    {x: 300, y: GY, healthFrac: 0.9}, // strong, near
    {x: 800, y: GY, healthFrac: 0.15}, // weak, far
  ];
  ok('L>7, roll<0.4 → weakest', pickTarget(enemies, 200, 10, () => 0.2) === 1);
  ok('L>7, 0.4≤roll<0.8 → nearest', pickTarget(enemies, 200, 10, () => 0.5) === 0);
  ok('L≤7 always uses the random branch', pickTarget(enemies, 200, 5, () => 0.6) === 1); // floor(0.6*2)=1
}

// 7. Weapon selection returns a valid ballistic weapon index.
{
  const pool = new Set(ballisticWeaponIndices());
  ok('ballistic pool is non-empty', pool.size > 0, `size=${pool.size}`);
  let allValid = true;
  for (let i = 0; i < 40; i++) {
    const w = pickWeapon(1 + (i % AI_LEVEL_MAX));
    if (!pool.has(w)) allValid = false;
  }
  ok('picked weapons are always in the ballistic pool', allValid);
}

// 8. Move utilities resolve (bot movement spends a turn on one of these).
{
  const moves = moveWeaponIndices();
  ok('the three Move utilities resolve', moves.length === 3, `found=${moves.length}`);
  ok(
    'Move utilities are extType-3 Utility weapons',
    moves.every(i => WEAPON_DATABASE[i].extType === 3 && WEAPON_DATABASE[i].type === 'Utility'),
  );
  ok('pickMoveWeapon returns one of them', moves.includes(pickMoveWeapon(() => 0.5)));
}

console.log(`\n${pass}/${pass + fail} AI checks passed`);
process.exit(fail ? 1 : 0);
