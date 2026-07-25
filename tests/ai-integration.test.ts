/**
 * Integration test: drive a real bot turn through CGameController and confirm the
 * AI aims at the enemy with a proper firing solution (real ballistics + full power
 * scale), not the old naive ~45°/≤100-power guess.
 */
import {describe, it, expect, vi} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {simulateMiss, AI_LEVEL_MAX, AI_LEVEL_ULTRA, type AimField} from '../src/core/CBotAI';
import {Vec2} from '../src/math/Vec2';
import {GameConfig} from '../src/core/CGameConfig';

// This test validates single-shot aim accuracy, which assumes the enemy is within
// one screen. Pin the world to a single screen (Land Size = 1) so tanks aren't
// spread across a multi-screen map, where engaging takes scrolling/driving, not one
// shot (that's a separate large-map concern).
GameConfig.landSize = 1;

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
  m_land: {getHeightAt(x: number): number; width: number; height: number};
  m_wind: Vec2;
  executeBotTurn(): void;
};

// Run several fresh games (terrain is random) so the check doesn't hinge on one
// layout; the AI should aim well on the large majority of them.
let good = 0;
const RUNS = 6;
let sawFullPower = false;

for (let run = 0; run < RUNS; run++) {
  const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
  gc.startGame(2); // tank 0 = human (left), tank 1 = bot (right)  [random terrain]
  gc.setDifficulty(AI_LEVEL_MAX); // sharpest aim → ~zero added error
  gc.m_currentPlayerIndex = 1; // hand the turn to the bot
  // Suppress the random reposition (>BOT_MOVE_CHANCE) so the aim is decided
  // synchronously here rather than deferred until after a drive animation.
  const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99);
  gc.executeBotTurn(); // decides angle + power (fire is deferred/frozen)
  rnd.mockRestore();

  const power = gc.getPower();
  const angle = gc.getAngle();
  if (power >= 140 && power <= 1000) sawFullPower = true;

  // Reproduce the bot's shot and measure how close it passes the enemy.
  const field: AimField = {
    heightAt: x => gc.m_land.getHeightAt(x),
    width: gc.m_land.width,
    height: gc.m_land.height,
  };
  const enemy = gc.m_tanks[0].getPosition();
  const origin = gc.m_tanks[1].muzzleForAngle(angle);
  const miss = simulateMiss(origin, angle, power, gc.m_wind, field, {x: enemy.x, y: enemy.y});
  if (miss < 60) good++;
}

describe('Bot AI (integration)', () => {
  it('bot fires at real power (140..1000, not the old ≤100 cap)', () => {
    expect(sawFullPower).toBe(true);
  });

  it('bot lands near the enemy on most maps (within 60px)', () => {
    // The old AI capped power at 100 (range ~16px) and never reached a target 600px
    // away; the new one uses the full scale.
    expect(good).toBeGreaterThanOrEqual(RUNS - 1);
  });
});

// Ultra (level 11) routes through the whole planner pipeline (buildUltraCtx → planUltraTurn →
// execute). This drives it end-to-end through the real controller to catch any wiring break the
// pure-planner unit tests can't, and confirms it commits a real firing solution on a one-screen map.
describe('Ultra AI (level 11) — end-to-end wiring', () => {
  it('picks and commits a real shot at the enemy without error', () => {
    let ultraGood = 0;
    const RUNS_U = 6;
    for (let run = 0; run < RUNS_U; run++) {
      const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
      gc.startGame(2);
      gc.setDifficulty(AI_LEVEL_ULTRA); // route to executeUltraTurn
      gc.m_currentPlayerIndex = 1; // bot's turn
      const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99); // no trick play / random branch
      gc.executeBotTurn();
      rnd.mockRestore();

      const power = gc.getPower();
      const angle = gc.getAngle();
      expect(power).toBeGreaterThanOrEqual(100); // committed a fire (not left at a stale 0)
      const field: AimField = {
        heightAt: x => gc.m_land.getHeightAt(x),
        width: gc.m_land.width,
        height: gc.m_land.height,
      };
      const enemy = gc.m_tanks[0].getPosition();
      const origin = gc.m_tanks[1].muzzleForAngle(angle);
      const miss = simulateMiss(origin, angle, power, gc.m_wind, field, {x: enemy.x, y: enemy.y});
      if (miss < 60) ultraGood++;
    }
    expect(ultraGood).toBeGreaterThanOrEqual(RUNS_U - 1); // Ultra hits on the large majority
  });
});
