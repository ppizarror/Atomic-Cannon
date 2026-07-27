/**
 * Regression: the bot must lead GUSTING Realistic wind, not aim at the sustained mean.
 *
 * In Realistic mode the wind the shots actually feel is `m_effWind = m_wind ⊙ gustFactor(t)` — a
 * ±30% breathing envelope. The aim solver used to be handed the bare `m_wind` (no gust), so every
 * bot — mastery included — aimed for the mean and the gust blew the shot off. The fix feeds the
 * solver the launch-time gust clock so it integrates the SAME breathing wind the real shot will.
 */
import {describe, it, expect, afterEach} from 'vitest';

import {bestAim, simulateMiss, type AimField} from '../src/core/CBotAI';
import {gustFactor, GUST_FRAC, WIND_MODEL} from '../src/core/wind';
import {GameConfig} from '../src/core/CGameConfig';

const GY = 500; // flat ground line
const flat: AimField = {heightAt: () => GY, width: 1000, height: 620};
const muzzleAt = (x: number) => () => ({x, y: GY - 24});

describe('gustFactor — shared wind gust envelope', () => {
  const original = GameConfig.windModel;
  afterEach(() => (GameConfig.windModel = original));

  it('is a flat 1 in Linear mode and breathes (bounded by ±GUST_FRAC) in Realistic', () => {
    GameConfig.windModel = WIND_MODEL.LINEAR;
    expect(gustFactor(5)).toEqual({x: 1, y: 1}); // no gusts in Linear → sustained wind

    GameConfig.windModel = WIND_MODEL.REALISTIC;
    const g = gustFactor(5);
    expect(Math.abs(g.x - 1)).toBeGreaterThan(0.05); // it actually deviates
    expect(Math.abs(g.x - 1)).toBeLessThanOrEqual(GUST_FRAC + 1e-9); // …but never past ±FRAC
    expect(Math.abs(g.y - 1)).toBeLessThanOrEqual(GUST_FRAC * 0.5 + 1e-9); // vertical flutter is half
  });
});

describe('Bot AI leads gusting Realistic wind', () => {
  const original = GameConfig.windModel;
  afterEach(() => (GameConfig.windModel = original));

  it('a gust-AWARE solve hits under the real gust where a gust-BLIND (mean-wind) solve misses', () => {
    GameConfig.windModel = WIND_MODEL.REALISTIC;
    const target = {x: 700, y: GY - 10};
    const origin = {x: 180, y: GY - 24};
    const wind = {x: 4, y: 0}; // strong sustained crosswind…
    const gustT0 = 5.0; // …that gusts DOWN to ~0.84× at this launch phase (a -16% lull)
    expect(Math.abs(gustFactor(gustT0).x - 1)).toBeGreaterThan(0.1); // precondition: the gust matters

    // AWARE (the fix): predict the breathing wind over the flight, starting at the launch phase.
    const aware = bestAim(muzzleAt(180), target, wind, flat, gustT0);
    // BLIND (the old bug): solve for the sustained mean wind, ignoring the gust entirely.
    const blind = bestAim(muzzleAt(180), target, wind, flat);

    // Fly BOTH under the TRUE gusting wind — simulateMiss(…, gustT0) matches what the real shot flies.
    const awareMiss = simulateMiss(origin, aware.angleDeg, aware.power, wind, flat, target, gustT0);
    const blindMiss = simulateMiss(origin, blind.angleDeg, blind.power, wind, flat, target, gustT0);

    expect(awareMiss).toBeLessThan(25); // the aware solve lands on the target under the real gust
    expect(blindMiss).toBeGreaterThan(awareMiss + 5); // the blind solve is clearly worse — gust-blown
  });

  it('with the gust modelled, the solved arc re-simulates to the same miss (physics match)', () => {
    GameConfig.windModel = WIND_MODEL.REALISTIC;
    const target = {x: 640, y: GY - 10};
    const origin = {x: 200, y: GY - 24};
    const wind = {x: -3, y: 0};
    const gustT0 = 2.0;
    const aim = bestAim(muzzleAt(200), target, wind, flat, gustT0);
    const check = simulateMiss(origin, aim.angleDeg, aim.power, wind, flat, target, gustT0);
    expect(Math.abs(check - aim.dist)).toBeLessThan(1e-6); // the solver's arc IS the flown arc
  });
});
