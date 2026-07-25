/**
 * Integration test: drive a real bot turn through CGameController and confirm the
 * AI aims at the enemy with a proper firing solution (real ballistics + full power
 * scale), not the old naive ~45°/≤100-power guess.
 */
import {describe, it, expect, vi} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {simulateMiss, AI_LEVEL_ULTRA, type AimField} from '../src/core/CBotAI';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
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
  init(x: number, land: unknown): void;
};
// Accessor view over CGameController's soft-private (`m_`) internals plus the few
// public methods the test drives. Kept standalone (not `CGameController & …`) because
// intersecting a class that has private members collapses the type to `never`.
type Econ = {getCredits(): number; getOwned(i: number): number; isUnlimited(i: number): boolean};
type GC = {
  startGame(numTanks: number): void;
  setDifficulty(level: number): void;
  setHumanCount(n: number): void;
  setStartCredits(n: number): void;
  economyFor(tank: Tank): Econ;
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
  gc.setDifficulty(AI_LEVEL_ULTRA - 1); // sharpest NON-Ultra aim (10) → ~zero added error, plain solve
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
  it('runs the whole pipeline and commits a real fire without error', () => {
    // Aim ACCURACY is covered by the level-10 ballistic test + the pure-planner unit tests. Here we
    // only exercise the full Ultra pipeline (economy → buildUltraCtx → planUltraTurn → execute) end to
    // end and confirm it commits a fire (not a stale 0). The committed weapon may be a beam (hitscan)
    // or a cheap ranging shell, so a ballistic miss check doesn't apply.
    for (let run = 0; run < 6; run++) {
      const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
      gc.startGame(2);
      gc.setDifficulty(AI_LEVEL_ULTRA); // route to executeUltraTurn
      gc.m_currentPlayerIndex = 1; // bot's turn
      const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99); // no trick play / random branch
      gc.executeBotTurn();
      rnd.mockRestore();
      expect(gc.getPower()).toBeGreaterThanOrEqual(100); // committed a fire on a one-screen 1v1
    }
  });

  it('a flush Ultra bot SPENDS its credits (buys defense/offense) instead of hoarding + Shell-spamming', () => {
    const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
    gc.setHumanCount(0); // both tanks are bots
    gc.setDifficulty(AI_LEVEL_ULTRA);
    gc.setStartCredits(6000); // flush — an old-behaviour bot would sit on this
    gc.startGame(2);
    gc.m_currentPlayerIndex = 0;

    const econ = gc.economyFor(gc.m_tanks[0]);
    const before = econ.getCredits();
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    gc.executeBotTurn(); // runs the Ultra economy pass, then acts
    rnd.mockRestore();

    expect(econ.getCredits()).toBeLessThan(before - 1000); // spent a real chunk, not hoarding
    // …and it now holds finite (non-Shell) rounds/utilities, not just the free staple.
    let finiteOwned = 0;
    for (let i = 0; i < WEAPON_DATABASE.length; i++) {
      if (!econ.isUnlimited(i)) finiteOwned += econ.getOwned(i);
    }
    expect(finiteOwned).toBeGreaterThan(0);
  });

  it('buys a DEATH (kamikaze) round only when SURROUNDED by 2+ enemies, not when spread', () => {
    const ownsDeath = (gc: GC, tank: Tank): boolean => {
      const e = gc.economyFor(tank);
      for (let i = 0; i < WEAPON_DATABASE.length; i++) {
        if (!e.isUnlimited(i) && e.getOwned(i) > 0 && (WEAPON_DATABASE[i].extType ?? 0) === 12) return true;
      }
      return false;
    };
    const runTurn = (xs: number[]): GC => {
      const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
      gc.setHumanCount(0);
      gc.setDifficulty(AI_LEVEL_ULTRA);
      gc.setStartCredits(15000); // plenty left after the leverage buys
      gc.startGame(3);
      gc.m_tanks.forEach((t, i) => t.init(xs[i], gc.m_land)); // place the squad
      gc.m_currentPlayerIndex = 0;
      const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99);
      gc.executeBotTurn(); // runs the Ultra economy
      rnd.mockRestore();
      return gc;
    };

    const surrounded = runTurn([300, 315, 330]); // squad tightly clustered around tank 0
    expect(ownsDeath(surrounded, surrounded.m_tanks[0])).toBe(true);

    const spread = runTurn([80, 460, 860]); // enemies far off
    expect(ownsDeath(spread, spread.m_tanks[0])).toBe(false);
  });
});
