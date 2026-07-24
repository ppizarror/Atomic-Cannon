/**
 * Wind-model tests — the Gameplay → Wind Model switch (core/wind.ts).
 *
 * Linear (default): wind is uniform at every altitude, exactly as the classic game.
 * Realistic: an atmospheric boundary layer — 0 at the ground, ramping to full aloft — so a
 * shot skimming a hill barely drifts while the top of a tall arc catches the full wind.
 *
 * These assert the shared `windProfile` and that CShot honours it via its optional ground
 * provider, which is the same profile the aim AI simulates (so bot shots stay accurate).
 */
import {describe, it, expect, afterEach} from 'vitest';

import {CShot} from '../src/core/CShot';
import {Vec2} from '../src/math/Vec2';
import {GameConfig} from '../src/core/CGameConfig';
import {WIND_MODEL, WIND_PROFILE_H, windProfile, boundaryFactor} from '../src/core/wind';

afterEach(() => {
  GameConfig.windModel = WIND_MODEL.LINEAR; // restore the default between tests
});

describe('windProfile', () => {
  it('is a constant 1 at every height in Linear mode', () => {
    GameConfig.windModel = WIND_MODEL.LINEAR;
    expect(windProfile(-100)).toBe(1);
    expect(windProfile(0)).toBe(1);
    expect(windProfile(10)).toBe(1);
    expect(windProfile(WIND_PROFILE_H + 500)).toBe(1);
  });

  it('ramps 0-at-ground → 1-aloft in Realistic mode', () => {
    GameConfig.windModel = WIND_MODEL.REALISTIC;
    expect(windProfile(-5)).toBe(0); // below the surface
    expect(windProfile(0)).toBe(0); // at the surface
    expect(windProfile(WIND_PROFILE_H / 2)).toBeCloseTo(0.5, 5); // half-way up the layer
    expect(windProfile(WIND_PROFILE_H)).toBe(1); // top of the boundary layer
    expect(windProfile(WIND_PROFILE_H * 3)).toBe(1); // well above → clamped
  });
});

describe('boundaryFactor (model-independent smoke easing)', () => {
  it('ramps 0-at-ground → 1-aloft in BOTH wind models', () => {
    for (const model of [WIND_MODEL.LINEAR, WIND_MODEL.REALISTIC]) {
      GameConfig.windModel = model;
      expect(boundaryFactor(0)).toBe(0); // at the surface — no wind, in either mode
      expect(boundaryFactor(WIND_PROFILE_H / 2)).toBeCloseTo(0.5, 5);
      expect(boundaryFactor(WIND_PROFILE_H)).toBe(1);
      expect(boundaryFactor(WIND_PROFILE_H * 2)).toBe(1);
    }
  });
});

describe('CShot wind model', () => {
  // Fire straight up (90°) with zero power so gravity/thrust don't move x — the whole
  // horizontal displacement is wind drift. Ground sits far below at y=1000.
  const groundY = 1000;
  const groundAt = () => groundY;

  const driftAt = (startY: number, useGround: boolean): number => {
    const shot = new CShot();
    shot.init(new Vec2(0, startY), 90, 0, 0, 0);
    const wind = new Vec2(5, 0);
    for (let i = 0; i < 60; i++) shot.update(1 / 60, wind, useGround ? groundAt : undefined);
    return shot.getPosition().x;
  };

  it('Linear: a low shot and a high shot drift identically (uniform wind)', () => {
    GameConfig.windModel = WIND_MODEL.LINEAR;
    const low = driftAt(groundY - 10, true);
    const high = driftAt(groundY - 600, true);
    expect(Math.abs(low - high)).toBeLessThan(1e-6);
    expect(low).toBeGreaterThan(1); // and it does drift
  });

  it('Realistic: a ground-hugging shot drifts far less than a high one', () => {
    GameConfig.windModel = WIND_MODEL.REALISTIC;
    const low = driftAt(groundY - 10, true); // 10px above ground → near-zero factor
    const high = driftAt(groundY - 600, true); // well above the boundary layer → full wind
    expect(low).toBeLessThan(high * 0.2);
    expect(high).toBeGreaterThan(1);
  });

  it('Realistic without a ground provider falls back to uniform (factor 1)', () => {
    GameConfig.windModel = WIND_MODEL.REALISTIC;
    const withGround = driftAt(groundY - 10, true); // attenuated
    const noGround = driftAt(groundY - 10, false); // uniform fallback
    expect(noGround).toBeGreaterThan(withGround * 5);
  });
});

describe('CShot air drag (Realistic only)', () => {
  // Fire horizontally (0°) in DEAD CALM (no wind) so the only thing that can change the horizontal
  // speed is drag. Linear → vx constant; Realistic → vx bleeds off.
  const vxAfter = (steps: number): number => {
    const shot = new CShot();
    shot.init(new Vec2(0, 0), 0, 800, 0, 0); // 0° → straight to the right
    const calm = new Vec2(0, 0);
    for (let i = 0; i < steps; i++) shot.update(1 / 60, calm);
    return shot.getVelocity().x;
  };

  it('Linear: horizontal speed is preserved (drag-free ballistics)', () => {
    GameConfig.windModel = WIND_MODEL.LINEAR;
    const v0 = vxAfter(0);
    const v1 = vxAfter(120); // 2 s
    expect(v1).toBeCloseTo(v0, 5);
  });

  it('Realistic: horizontal speed decays under drag', () => {
    GameConfig.windModel = WIND_MODEL.REALISTIC;
    const v0 = vxAfter(0);
    const v1 = vxAfter(120); // 2 s
    expect(v1).toBeLessThan(v0 * 0.9); // clearly slowed
    expect(v1).toBeGreaterThan(0); // but still moving forward
  });
});
