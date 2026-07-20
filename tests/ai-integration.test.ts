/**
 * Integration test: drive a real bot turn through CGameController and confirm the
 * AI aims at the enemy with a proper firing solution (real ballistics + full power
 * scale), not the old naive ~45°/≤100-power guess.
 * Run: pnpm tsx tests/ai-integration.test.ts   (or `pnpm test`)
 */
import { installDomMocks, makeCanvas } from './_dom';
installDomMocks();

// Freeze the scheduler so the bot's deferred fire() doesn't cascade — we only want
// the angle/power it decided on.
(globalThis as unknown as { setTimeout: unknown }).setTimeout = () => 0;

import { CGameController } from '../src/game/CGameController';
import { simulateMiss, AI_LEVEL_MAX, type AimField } from '../src/core/CBotAI';
import { Vec2 } from '../src/math/Vec2';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

type Tank = {
  getPosition(): Vec2;
  muzzleForAngle(deg: number): Vec2;
};
// Accessor view over CGameController's soft-private (`m_`) internals plus the few
// public methods the test drives. Kept standalone (not `CGameController & …`) because
// intersecting a class that has private members collapses the type to `never`.
type GC = {
  startGame(numTanks: number): void;
  setDifficulty(level: number): void;
  getPower(): number;
  getAngle(): number;
  m_tanks: Tank[];
  m_currentPlayerIndex: number;
  m_land: { getHeightAt(x: number): number; width: number; height: number };
  m_wind: Vec2;
  executeBotTurn(): void;
};

console.log('Bot AI (integration)');

// Run several fresh games (terrain is random) so the check doesn't hinge on one
// layout; the AI should aim well on the large majority of them.
let good = 0;
const RUNS = 6;
let sawFullPower = false;

for (let run = 0; run < RUNS; run++) {
  const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
  gc.startGame(2);                 // tank 0 = human (left), tank 1 = bot (right)  [random terrain]
  gc.setDifficulty(AI_LEVEL_MAX);  // sharpest aim → ~zero added error
  gc.m_currentPlayerIndex = 1;     // hand the turn to the bot
  // Suppress the random reposition (>BOT_MOVE_CHANCE) so the aim is decided
  // synchronously here rather than deferred until after a drive animation.
  const realRandom = Math.random;
  Math.random = () => 0.99;
  gc.executeBotTurn();             // decides angle + power (fire is deferred/frozen)
  Math.random = realRandom;

  const power = gc.getPower();
  const angle = gc.getAngle();
  if (power >= 140 && power <= 1000) sawFullPower = true;

  // Reproduce the bot's shot and measure how close it passes the enemy.
  const field: AimField = {
    heightAt: (x) => gc.m_land.getHeightAt(x),
    width: gc.m_land.width,
    height: gc.m_land.height,
  };
  const enemy = gc.m_tanks[0].getPosition();
  const origin = gc.m_tanks[1].muzzleForAngle(angle);
  const miss = simulateMiss(origin, angle, power, gc.m_wind, field, { x: enemy.x, y: enemy.y });
  if (miss < 60) good++;
}

// The old AI capped power at 100 (range ~16px) and never reached a target 600px
// away; the new one uses the full scale.
ok('bot fires at real power (140..1000, not the old ≤100 cap)', sawFullPower);
ok(`bot lands near the enemy on most maps (${good}/${RUNS} within 60px)`, good >= RUNS - 1, `good=${good}/${RUNS}`);

console.log(`\n${pass}/${pass + fail} AI integration checks passed`);
process.exit(fail ? 1 : 0);
