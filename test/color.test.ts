/**
 * Colour maths behind the HUD's team accents. The team palette spans pure blue, navy, maroon and
 * purple — all of which read as near-black — so accents drawn over a dark plate are lifted to a
 * floor brightness first.
 */
import {describe, it, expect} from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  mixToward,
  luminance,
  ensureLuminance,
  WHITE,
  BLACK,
} from '../src/math/color';
import {TEAM_COLORS} from '../src/core/CTank';

describe('luminance', () => {
  it('spans black to white', () => {
    expect(luminance(BLACK)).toBe(0);
    expect(luminance(WHITE)).toBe(1);
  });

  it('weights green over blue — why pure blue reads as near-black', () => {
    const blue = luminance(hexToRgb('#0000ff'));
    const green = luminance(hexToRgb('#00ff00'));
    expect(blue).toBeLessThan(0.15); // the whole reason the old blue chip vanished
    expect(green).toBeGreaterThan(blue * 4);
  });
});

describe('ensureLuminance', () => {
  const MIN = 0.55;

  it('lifts every team colour to the floor', () => {
    for (const hex of Object.values(TEAM_COLORS)) {
      const lifted = ensureLuminance(hexToRgb(hex), MIN);
      expect(luminance(lifted)).toBeGreaterThanOrEqual(MIN - 1e-9);
      for (const ch of [lifted.r, lifted.g, lifted.b]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it('hits the floor exactly — no overshoot, no washing colour out', () => {
    // Pure blue is the palette's darkest entry; it must land ON the floor, not past it.
    const lifted = ensureLuminance(hexToRgb('#0000ff'), MIN);
    expect(luminance(lifted)).toBeCloseTo(MIN, 6);
    expect(lifted.b).toBeGreaterThan(lifted.r); // still recognisably blue
  });

  it('leaves already-bright colours untouched', () => {
    for (const hex of ['#00ff00', '#ffff00', '#00ffff', '#ffffff']) {
      const rgb = hexToRgb(hex);
      expect(ensureLuminance(rgb, MIN)).toEqual(rgb);
    }
  });

  it('the darkest entries become genuinely visible borders', () => {
    // navy / maroon / purple all land well under the floor raw — unusable as an outline — and
    // each comes back sitting exactly on it.
    for (const hex of ['#000080', '#800000', '#800080']) {
      const raw = hexToRgb(hex);
      expect(luminance(raw)).toBeLessThan(MIN / 2);
      expect(luminance(ensureLuminance(raw, MIN))).toBeCloseTo(MIN, 6);
    }
  });
});

describe('the active-row plate', () => {
  it('drives each team colour to a dark, still-tinted backing', () => {
    for (const hex of Object.values(TEAM_COLORS)) {
      const plate = mixToward(hexToRgb(hex), BLACK, 0.72);
      expect(luminance(plate)).toBeLessThan(0.3); // dark enough for the white outlined text
      expect(rgbToHex(plate.r, plate.g, plate.b)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
