/**
 * Regression: there cannot be radiation floating in air.
 *
 * The settled coat is drawn by spreading each hot grain's dot onto its neighbours — that bleed is
 * what softens the join between contaminated earth and the ground around it. It checked bounds, and
 * it checked that the target was not already hot, but it never checked that there was any GROUND
 * there. So every grain lying on the surface bled its dot straight upward into the sky.
 *
 * On flat ground that is a 1-2px halo nobody notices. Along a cliff edge or a fresh crater rim —
 * where the terrain stops abruptly and every grain on that line is a surface grain — it becomes a
 * continuous band of glow hanging off the terrain with nothing underneath it. It also read as a bug
 * in something else entirely: a rocket fired into contaminated ground appeared not to clean it,
 * when in fact the earth (and its radiation) had been removed correctly and what remained was the
 * halo bleeding off the rim the rocket had just cut.
 *
 * The invariant is the simple one: a lit pixel of the glow layer must sit on solid terrain. This
 * exercises the REAL bake through `draw()` — the headless canvas stub captures what `putImageData`
 * writes — because the bug lived in the compositing, not in the radiation channel, and every
 * data-level assertion in the suite passed happily while it was there.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';
import {makeCanvas, type MockImage} from './_dom';

type Priv = {
  m_arrHeights: Int16Array;
  m_pixels: Uint32Array | null;
  m_radSpecks: unknown[];
  m_radGlowCanvas: (HTMLCanvasElement | null)[];
  m_radGlowX: number;
  m_radGlowY: number;
  m_nWidth: number;
  m_nHeight: number;
};

const SOLID = 0xff3c5a1e >>> 0;

/** A land with a sheer CLIFF: high ground on the left, a drop at `cliffX`, low ground on the right.
 *  The edge is the case that matters — it is a column of surface grains stacked vertically. */
function cliffLand(W: number, H: number, cliffX: number, hi: number, lo: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as Priv;
  const px = new Uint32Array(W * H);
  for (let x = 0; x < W; x++) {
    const surf = x < cliffX ? hi : lo;
    p.m_arrHeights[x] = surf;
    for (let y = surf; y < H; y++) px[y * W + x] = SOLID;
  }
  p.m_pixels = px;
  return land;
}

function settleFallout(land: CLand): void {
  const p = land as unknown as Priv;
  for (let i = 0; i < 500 && p.m_radSpecks.length > 0; i++) land.update(1 / 60);
}

/** Every lit texel of the baked glow, in WORLD coordinates. */
function litTexels(land: CLand): {x: number; y: number}[] {
  const p = land as unknown as Priv;
  const out: {x: number; y: number}[] = [];
  for (const cv of p.m_radGlowCanvas) {
    if (!cv) continue;
    const img = (cv as unknown as {lastImage: MockImage | null}).lastImage;
    if (!img) continue;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        // Anything meaningfully lit. A near-zero texel is the kernel's outermost tail and would
        // not be visible; the band this guards against is bright.
        if (img.data[o] + img.data[o + 1] + img.data[o + 2] < 12) continue;
        out.push({x: p.m_radGlowX + x, y: p.m_radGlowY + y});
      }
  }
  return out;
}

describe('CLand — the radiation glow never lights empty space', () => {
  it('a coat along a cliff edge does not glow off into the sky', () => {
    const W = 400,
      H = 300,
      cliffX = 200;
    const land = cliffLand(W, H, cliffX, 120, 220); // 100px sheer drop
    const p = land as unknown as Priv;

    // Contaminate the high ground right up to the edge.
    land.blastIradiate(cliffX - 40, 120, 60, 12, 30, [255, 46, 20]);
    settleFallout(land);

    land.draw(makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D);

    const lit = litTexels(land);
    expect(lit.length).toBeGreaterThan(50); // the coat really did bake something

    const px = p.m_pixels!;
    const inAir = lit.filter(t => {
      if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) return true; // off-world is air too
      return (px[t.y * W + t.x] & 0xff000000) === 0; // lit, but no terrain there
    });
    expect(inAir).toHaveLength(0);
  });

  it('a fresh crater rim does not leave a halo hanging over the hole', () => {
    const W = 400,
      H = 300,
      surf = 150;
    const land = cliffLand(W, H, W, surf, surf); // flat
    const p = land as unknown as Priv;

    land.blastIradiate(200, surf, 90, 12, 30, [255, 46, 20]);
    settleFallout(land);
    // Blow a hole through the middle of the contamination — the rocket case. The earth it removes
    // takes its radiation with it, and the new rim must not glow into the void it just opened.
    land.carveDiscCollapse(200, surf + 8, 40, true, false, true);
    for (let i = 0; i < 200; i++) land.update(1 / 60);

    land.draw(makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D);

    const px = p.m_pixels!;
    const inAir = litTexels(land).filter(t => {
      if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) return true;
      return (px[t.y * W + t.x] & 0xff000000) === 0;
    });
    expect(inAir).toHaveLength(0);
  });
});
