/**
 * Shot range is resolution-INDEPENDENT: a max-power shot crosses the world at 1× land size on
 * every display width. The world is sized in display pixels, so a fixed px/s launch speed used to
 * reach a shrinking fraction of the world as the screen widened (on an ultrawide, power 1000 could
 * not even cross the map). `launchSpeed` now scales by √(viewWidth / LAUNCH_REF_WIDTH).
 */
import {describe, it, expect, afterAll} from 'vitest';
import {launchSpeed, SHOT_GRAVITY} from '../src/core/CShot';
import {GameConfig} from '../src/core/CGameConfig';

// Analytic flat-ground range at the 45° max-range angle: v²·sin(90°)/g = v²/g. The integrator
// scales gravity by √worldScale (same map-size zoom as the launch speed), so use that here.
const maxRange = (): number =>
  launchSpeed(1000) ** 2 / (SHOT_GRAVITY * Math.sqrt(GameConfig.worldScale));

afterAll(() => {
  GameConfig.viewWidth = 1000;
  GameConfig.worldScale = 1;
  GameConfig.powerScale = 1;
});

describe('Shot range (resolution-independent max power)', () => {
  it('power 1000 comfortably overshoots the world at 1× on every display width', () => {
    GameConfig.worldScale = 1; // 1× land size → world width == view width
    GameConfig.powerScale = 1;
    for (const viewW of [1280, 1920, 2560, 3440, 3840]) {
      GameConfig.viewWidth = viewW;
      const range = maxRange();
      // ~2× the world — "easily passes the other end". Before the fix this was a fixed 2000px,
      // so on a 3440-wide ultrawide it was only ~0.58× the world (could not cross).
      expect(range).toBeGreaterThan(viewW * 1.8);
      expect(range).toBeLessThan(viewW * 2.2);
    }
  });

  it('the overshoot ratio is the SAME at every resolution (no resolution dependence)', () => {
    GameConfig.worldScale = 1;
    GameConfig.powerScale = 1;
    const ratio = (viewW: number): number => {
      GameConfig.viewWidth = viewW;
      return maxRange() / viewW;
    };
    const r1280 = ratio(1280);
    const r3440 = ratio(3440);
    expect(Math.abs(r1280 - r3440)).toBeLessThan(0.02); // identical fraction of the world
  });
});
