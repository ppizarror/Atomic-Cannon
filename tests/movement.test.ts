/**
 * Deterministic tests for the tank ground-drive (bot repositioning): it crawls to
 * a destination on flat ground, stops at a wall it can't climb, and clamps at the
 * map edge.
 * Run: pnpm tsx tests/movement.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';
installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CTank} from '../src/core/CTank';
import type {CLand} from '../src/core/CLand';
import {CGameController} from '../src/game/CGameController';
import {Vec2} from '../src/math/Vec2';

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

// Minimal land stand-ins (only what CTank.update touches).
const flat = (): CLand =>
  ({
    width: 900,
    height: 600,
    getHeightAt: () => 500,
    getNormal: () => new Vec2(0, -1),
  }) as unknown as CLand;
const wall = (): CLand =>
  ({
    width: 900,
    height: 600,
    getHeightAt: (x: number) => (x > 300 ? 300 : 500),
    getNormal: () => new Vec2(0, -1),
  }) as unknown as CLand;

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
  ok(
    'reaches the destination',
    Math.abs(t.getPosition().x - 400) < 2,
    `x=${t.getPosition().x.toFixed(1)}`,
  );
  ok('settles (not moving)', !t.isMoving() && !t.isDriving());
}

// 2. Drives left too.
{
  const land = flat();
  const t = new CTank('X', 0);
  t.init(600, land);
  t.startDrive(350);
  driveToRest(t, land);
  ok(
    'reaches a leftward destination',
    Math.abs(t.getPosition().x - 350) < 2,
    `x=${t.getPosition().x.toFixed(1)}`,
  );
}

// 3. A wall it can't climb stops the drive short.
{
  const land = wall();
  const t = new CTank('X', 0);
  t.init(200, land);
  t.startDrive(600); // target is past the wall at x>300
  driveToRest(t, land);
  ok(
    'stops before an unclimbable wall',
    t.getPosition().x < 320 && !t.isMoving(),
    `x=${t.getPosition().x.toFixed(1)}`,
  );
}

// 4. Clamps at the battlefield edge.
{
  const land = flat();
  const t = new CTank('X', 0);
  t.init(60, land);
  t.startDrive(-500); // off the left edge
  driveToRest(t, land);
  ok(
    'stops at/inside the left edge',
    t.getPosition().x >= 16 && t.getPosition().x < 60 && !t.isMoving(),
    `x=${t.getPosition().x.toFixed(1)}`,
  );
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

// 6. In-game: a bot's turn is MOVE or FIRE (mutually exclusive). A Move utility
//    drives the tank and ends the turn WITHOUT firing; otherwise it fires and does
//    not move. (Random maps: a bot can spawn boxed in, so "moved" is a majority.)
{
  // Standalone accessor view (see ai-integration.test.ts): intersecting the class,
  // which has private members, would collapse the type to `never`.
  type GC = {
    startGame(numTanks: number): void;
    setDifficulty(level: number): void;
    getShotCount(): number;
    update(dt: number): void;
    m_tanks: CTank[];
    m_currentPlayerIndex: number;
    executeBotTurn(): void;
  };
  const RUNS = 6;
  const run = (roll: number) => {
    const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
    gc.startGame(2);
    gc.setDifficulty(5);
    gc.m_currentPlayerIndex = 1;
    const bot = gc.m_tanks[1];
    const x0 = bot.getPosition().x;
    const realRandom = Math.random;
    Math.random = () => roll;
    gc.executeBotTurn();
    // Pump the sim: a firing bot resolves quickly (breaks on the shot); a moving bot
    // never fires, so it runs the full window (plenty for the drive to settle).
    for (let i = 0; i < 240 && gc.getShotCount() === 0; i++) gc.update(1 / 30);
    Math.random = realRandom;
    return {moved: Math.abs(bot.getPosition().x - x0) > 5, fired: gc.getShotCount() > 0};
  };

  // Forced MOVE (roll < BOT_MOVE_CHANCE): drives, ends the turn, never fires.
  let moved = 0,
    movedFired = 0;
  for (let r = 0; r < RUNS; r++) {
    const o = run(0.1);
    if (o.moved) moved++;
    if (o.fired) movedFired++;
  }
  ok('a moving bot actually moves', moved >= RUNS - 2, `${moved}/${RUNS}`);
  ok('a moving bot does NOT fire', movedFired === 0, `fired=${movedFired}/${RUNS}`);

  // Forced FIRE (roll > BOT_MOVE_CHANCE): fires, never drives.
  let fired = 0,
    firedMoved = 0;
  for (let r = 0; r < RUNS; r++) {
    const o = run(0.99);
    if (o.fired) fired++;
    if (o.moved) firedMoved++;
  }
  ok('a firing bot fires', fired === RUNS, `${fired}/${RUNS}`);
  ok('a firing bot does NOT move', firedMoved === 0, `moved=${firedMoved}/${RUNS}`);
}

console.log(`\n${pass}/${pass + fail} movement checks passed`);
process.exit(fail ? 1 : 0);
