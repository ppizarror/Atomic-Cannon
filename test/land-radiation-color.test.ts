/**
 * Radiation fallout specks jitter each RGB channel INDEPENDENTLY within the weapon's per-channel
 * irRGB max, so the cloud ranges dark→bright (natural sparkle) rather than every speck carrying the
 * same flat tint. Each channel stays within [0, max]; the channels vary independently of one another.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';

type Priv = {
  m_arrHeights: Int16Array;
  m_radSpecks: {r: number; g: number; b: number}[];
};

function flatLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as Priv;
  for (let x = 0; x < W; x++) p.m_arrHeights[x] = surf;
  return land;
}

describe('CLand — radiation speck colour jitter', () => {
  it('each speck jitters R/G/B within the weapon per-channel max, ranging dark→bright', () => {
    const land = flatLand(300, 300, 150);
    const p = land as unknown as Priv;

    const irR = 255,
      irG = 46,
      irB = 20;
    land.blastIradiate(150, 150, 40, 12, 6, [irR, irG, irB]);
    const specks = p.m_radSpecks;
    expect(specks.length).toBeGreaterThan(100);

    // Every channel stays within its per-channel max (integer, 0..max).
    for (const s of specks) {
      expect(Number.isInteger(s.r) && Number.isInteger(s.g) && Number.isInteger(s.b)).toBe(true);
      expect(s.r).toBeGreaterThanOrEqual(0);
      expect(s.r).toBeLessThanOrEqual(irR);
      expect(s.g).toBeLessThanOrEqual(irG);
      expect(s.b).toBeLessThanOrEqual(irB);
    }

    // The dominant (red) channel spans a wide range — dark grains AND bright ones — so the cloud
    // is not a flat uniform tint. (With ~700+ specks, uniform[0,255] all-equal is impossible.)
    const reds = specks.map(s => s.r);
    const minR = Math.min(...reds),
      maxR = Math.max(...reds);
    expect(maxR - minR).toBeGreaterThan(120); // real dark→bright spread, not a flat value
    expect(new Set(reds).size).toBeGreaterThan(20); // many distinct brightnesses

    // Channels vary INDEPENDENTLY: the red order doesn't lock-step the green/blue (a flat tint or a
    // single shared scalar would make r/g/b perfectly correlated). Just check they aren't identical.
    const someDiffProfile = specks.some(
      (s, i) => i > 0 && (s.g !== specks[0].g || s.b !== specks[0].b),
    );
    expect(someDiffProfile).toBe(true);
  });
});
