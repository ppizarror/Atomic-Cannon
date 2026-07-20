/**
 * Deterministic tests for the tank ground-drive (bot repositioning): it crawls to
 * a destination on flat ground, stops at a wall it can't climb, and clamps at the
 * map edge.
 * Run: pnpm tsx tests/movement.test.ts   (or `pnpm test`)
 */
import { installDomMocks } from './_dom';
installDomMocks();

import { CTank } from '../src/core/CTank';
import type { CLand } from '../src/core/CLand';
import { Vec2 } from '../src/math/Vec2';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

// Minimal land stand-ins (only what CTank.update touches).
const flat = (): CLand => ({ width: 900, height: 600, getHeightAt: () => 500, getNormal: () => new Vec2(0, -1) }) as unknown as CLand;
const wall = (): CLand => ({ width: 900, height: 600, getHeightAt: (x: number) => (x > 300 ? 300 : 500), getNormal: () => new Vec2(0, -1) }) as unknown as CLand;

// Drive a tank to rest (or a step cap).
function driveToRest(t: CTank, land: CLand, maxSteps = 1200) {
  for (let i = 0; i < maxSteps && t.isMoving(); i++) t.update(land, 1 / 30);
}

console.log('Tank ground-drive');

// 1. Crawls to the destination on flat ground and stops there.
{
  const land = flat();
  const t = new CTank('X', 0);
  t.init(200, land);
  t.startDrive(400);
  ok('isMoving right after startDrive', t.isMoving() && t.isDriving());
  driveToRest(t, land);
  ok('reaches the destination', Math.abs(t.getPosition().x - 400) < 2, `x=${t.getPosition().x.toFixed(1)}`);
  ok('settles (not moving)', !t.isMoving() && !t.isDriving());
}

// 2. Drives left too.
{
  const land = flat();
  const t = new CTank('X', 0);
  t.init(600, land);
  t.startDrive(350);
  driveToRest(t, land);
  ok('reaches a leftward destination', Math.abs(t.getPosition().x - 350) < 2, `x=${t.getPosition().x.toFixed(1)}`);
}

// 3. A wall it can't climb stops the drive short.
{
  const land = wall();
  const t = new CTank('X', 0);
  t.init(200, land);
  t.startDrive(600);              // target is past the wall at x>300
  driveToRest(t, land);
  ok('stops before an unclimbable wall', t.getPosition().x < 320 && !t.isMoving(), `x=${t.getPosition().x.toFixed(1)}`);
}

// 4. Clamps at the battlefield edge.
{
  const land = flat();
  const t = new CTank('X', 0);
  t.init(60, land);
  t.startDrive(-500);            // off the left edge
  driveToRest(t, land);
  ok('stops at/inside the left edge', t.getPosition().x >= 16 && t.getPosition().x < 60 && !t.isMoving(), `x=${t.getPosition().x.toFixed(1)}`);
}

// 5. stopMoving() cancels a drive.
{
  const land = flat();
  const t = new CTank('X', 0);
  t.init(200, land);
  t.startDrive(800);
  t.update(land, 1 / 30);
  t.stopMoving();
  ok('stopMoving cancels the drive', !t.isDriving() && !t.isMoving());
}

console.log(`\n${pass}/${pass + fail} movement checks passed`);
process.exit(fail ? 1 : 0);
