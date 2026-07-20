/**
 * Deterministic tests for the tank ground-drive (bot repositioning): it crawls to
 * a destination on flat ground, stops at a wall it can't climb, and clamps at the
 * map edge.
 * Run: pnpm tsx tests/movement.test.ts   (or `pnpm test`)
 */
import { installDomMocks, makeCanvas } from './_dom';
installDomMocks();
(globalThis as unknown as { setTimeout: unknown }).setTimeout = () => 0;

import { CTank } from '../src/core/CTank';
import type { CLand } from '../src/core/CLand';
import { CGameController } from '../src/game/CGameController';
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

// 6. In-game: the bot repositions, then aims & fires (full move→aim→fire flow).
//    Runs several random maps — it always fires; it moves on most (a bot can spawn
//    boxed in by terrain on rare maps, which is legitimate).
{
  type GC = CGameController & { m_tanks: CTank[]; m_currentPlayerIndex: number; executeBotTurn(): void; };
  const RUNS = 6;
  let started = 0, moved = 0, fired = 0;
  for (let r = 0; r < RUNS; r++) {
    const gc = new CGameController(makeCanvas(900, 600)) as GC;
    gc.startGame(2);
    gc.setDifficulty(5);
    gc.m_currentPlayerIndex = 1;                 // the bot's turn
    const bot = gc.m_tanks[1];
    const x0 = bot.getPosition().x;

    const realRandom = Math.random;
    Math.random = () => 0.1;                      // < BOT_MOVE_CHANCE → reposition; then aim
    gc.executeBotTurn();
    if (bot.isDriving() || bot.isMoving()) started++;
    for (let i = 0; i < 400 && gc.getShotCount() === 0; i++) gc.update(1 / 30);   // ≤13s
    Math.random = realRandom;

    if (Math.abs(bot.getPosition().x - x0) > 5) moved++;
    if (gc.getShotCount() > 0) fired++;
  }
  ok('bot always starts a reposition', started === RUNS, `${started}/${RUNS}`);
  ok('bot always fires after repositioning', fired === RUNS, `${fired}/${RUNS}`);
  ok('bot actually moves on most maps', moved >= RUNS - 2, `${moved}/${RUNS}`);
}

console.log(`\n${pass}/${pass + fail} movement checks passed`);
process.exit(fail ? 1 : 0);
