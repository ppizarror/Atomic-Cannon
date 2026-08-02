/**
 * Soil compaction (Gameplay switch, off by default): a nuke-class blast sends a compression wave
 * out through the ground, and the soil it passes over is SQUEEZED rather than excavated.
 *
 * The distinction matters. A crater removes earth: the column loses material and the strata below
 * the cut are simply gone. Compaction removes nothing — the surface drops because the soil under it
 * is packed tighter, so every band in the squeezed depth thins in proportion and the layering stays
 * readable. That is what makes it look like ground failing rather than another hole, and it is why
 * it can reach well past the crater without erasing the map.
 *
 * It travels outward over time so the ground gives way as a wave, which is also the gameplay: a
 * tank on the flat nearby keeps its footing for a moment, then loses it.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';

type Priv = {
  m_arrHeights: Int16Array;
  m_pixels: Uint32Array | null;
  m_shocks: unknown[];
  m_nWidth: number;
  m_nHeight: number;
};

/** Flat land with a real pixel buffer, banded so a squeeze is measurable in the strata. */
function bandedLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as Priv;
  const px = new Uint32Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = surf;
    // 10px stripes: alternating so we can count how many rows a band occupies.
    for (let y = surf; y < H; y++)
      px[y * W + x] = (Math.floor((y - surf) / 10) & 1) === 0 ? 0xff203040 : 0xff607080;
  }
  p.m_pixels = px;
  return land;
}

/** Run until the ground has finished moving — the wave passing is not the end of it. A column owes
 *  its subsidence when the front reaches it and pays it off over the following moment, so the last
 *  ground to drop does so well after the last shock has expired. */
function settle(land: CLand): void {
  for (let i = 0; i < 900 && land.isSettling(); i++) land.update(1 / 60);
}

/** Solid pixels in a column — the material it still holds. */
function solidCount(land: CLand, col: number): number {
  const p = land as unknown as Priv;
  const px = p.m_pixels;
  if (!px) return 0;
  let n = 0;
  for (let y = 0; y < p.m_nHeight; y++) if (px[y * p.m_nWidth + col] >>> 24) n++;
  return n;
}

describe('CLand — soil compaction', () => {
  it('sinks the surface most under the blast and less further out', () => {
    const W = 800,
      H = 400,
      surf = 150;
    const land = bandedLand(W, H, surf);
    const p = land as unknown as Priv;

    land.shockCompact(400, 300, 30);
    settle(land);

    // Measured over BANDS, not columns. The falloff is modulated by world-keyed noise so the ground
    // fails unevenly; a column-by-column ordering would be asserting the absence of exactly the
    // roughness this wants, and a narrow window can still straddle a single soft patch.
    const band = (from: number, to: number): number => {
      let sum = 0;
      for (let c = from; c <= to; c++) sum += p.m_arrHeights[c] - surf;
      return sum / (to - from + 1);
    };
    const near = band(400, 490), // inner third
      mid = band(500, 590),
      far = band(600, 690); // outer third
    expect(near).toBeGreaterThan(15); // ground zero sinks hard
    expect(near).toBeGreaterThan(mid); // …more than halfway out…
    expect(mid).toBeGreaterThan(far); // …which sinks more than out near the rim
    expect(p.m_arrHeights[720] - surf).toBe(0); // and nothing beyond the wave's reach moved at all

    // The roughness only ever eats INTO the profile — no column sinks past what was asked for, or
    // `maxSink` is a suggestion and a patch halfway out can outsink ground zero.
    for (let c = 400; c <= 700; c++) expect(p.m_arrHeights[c] - surf).toBeLessThanOrEqual(30);
  });

  it('SQUEEZES the soil rather than removing it — the column keeps its material', () => {
    const W = 800,
      H = 400,
      surf = 150;
    const land = bandedLand(W, H, surf);
    const before = solidCount(land, 400);

    land.shockCompact(400, 300, 30);
    settle(land);

    // The surface dropped, so the column is shorter — but only by what the squeeze took off the
    // top. A crater of the same depth would have cut the material out; this packs it down instead,
    // which is why the strata under it survive to be compressed rather than deleted.
    const after = solidCount(land, 400);
    const sank = (land as unknown as Priv).m_arrHeights[400] - surf;
    expect(after).toBe(before - sank);
    expect(sank).toBeGreaterThan(0);
  });

  it('arrives as a wave — near ground gives way before far ground', () => {
    const W = 800,
      H = 400,
      surf = 150;
    const land = bandedLand(W, H, surf);
    const p = land as unknown as Priv;

    land.shockCompact(400, 300, 30);
    // One frame in: the front has barely left the blast, so only close ground has moved.
    land.update(1 / 60);
    expect(p.m_arrHeights[400]).toBeGreaterThan(surf); // under the blast: already sinking
    expect(p.m_arrHeights[690]).toBe(surf); // out near the rim: still untouched

    settle(land);
    expect(p.m_arrHeights[690]).toBeGreaterThan(surf); // the wave got there in the end
  });

  it('counts as terrain still settling, so a turn cannot hand off mid-wave', () => {
    const land = bandedLand(800, 400, 150);
    land.shockCompact(400, 300, 30);
    land.update(1 / 60);
    expect(land.isSettling()).toBe(true);
    settle(land);
    expect(land.isSettling()).toBe(false);
  });
});
