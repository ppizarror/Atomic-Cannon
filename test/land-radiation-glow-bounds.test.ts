/**
 * The baked radiation glow must not be CLIPPED by its own buffer.
 *
 * The coat is baked once per terrain edit into a canvas sized to the hot earth's bounding box plus a
 * margin, and then drawn twice: once shrunk hard and blown back up (the bloom — the scaler's own
 * filtering is the blur), and once sharp on top. Both passes are confined to that one rect, so
 * anything reaching past its edge is not merely dimmed, it is sliced off square — and because the
 * sliced part is the soft bloom, what is left reads as a straight cut across the glow. It is worst
 * exactly where the coat is brightest: along a crater's rim, which is where the hot earth runs
 * closest to the box in the first place.
 *
 * Two things reach past the last hot pixel: a grain's kernel, which bleeds its dot onto neighbouring
 * ground, and the bloom's smear. So the invariant is not "the content fits" but "the content is
 * INSET far enough for the bloom to fall off inside the buffer" — a margin the bake has to reserve
 * up front, since by draw time there is nowhere left to put it.
 *
 * Exercised through the real bake (`draw()` → `putImageData`, captured by the headless canvas stub),
 * because the property lives in the compositing geometry and every data-level assertion about the
 * radiation channel passes happily either way.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';
import {makeCanvas, type MockImage} from './_dom';
import {landPriv} from './_internals';

const SOLID = 0xff3c5a1e >>> 0;

/** Clear texels the bake must leave around its content — must stay in step with `GLOW.BLOOM_SHRINK`,
 *  which is how far the shrink-and-blow-back-up pass smears a lit pixel. */
const BLOOM_REACH = 10;

/** Flat land with real pixels, so the glow bake's solidity test has something to read. */
function flatLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = landPriv(land);
  const px = new Uint32Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights![x] = surf;
    for (let y = surf; y < H; y++) px[y * W + x] = SOLID;
  }
  p.m_pixels = px;
  return land;
}

describe('CLand — the baked radiation glow keeps room for its own bloom', () => {
  it('no lit texel comes within the bloom reach of the buffer edge', () => {
    const W = 500,
      H = 400,
      surf = 180;
    const land = flatLand(W, H, surf);
    const p = landPriv(land);

    // Well clear of every world edge, so any margin the bake loses is its own doing and not the
    // clamp against the map bounds (which legitimately truncates the pad at x=0 / y=0).
    land.blastIradiate(250, surf, 90, 12, 30, [60, 255, 60]);
    for (let i = 0; i < 500 && p.m_radSpecks.length > 0; i++) land.update(1 / 60);

    land.draw(makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D);

    let lit = 0;
    let worst = Number.POSITIVE_INFINITY;
    for (const cv of p.m_radGlowCanvas) {
      if (!cv) continue;
      const img = (cv as unknown as {lastImage: MockImage | null}).lastImage;
      if (!img) continue;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const o = (y * img.width + x) * 4;
          if (img.data[o] + img.data[o + 1] + img.data[o + 2] < 1) continue; // painted nothing here
          lit++;
          worst = Math.min(worst, x, y, img.width - 1 - x, img.height - 1 - y);
        }
    }

    expect(lit).toBeGreaterThan(50); // the coat really did bake something to measure
    // A grain sitting on the very edge of the hot box still has to bloom into empty buffer, not
    // into the seam — a flat 2px pad leaves 0-2 texels here and the coat ends in a hard rectangle.
    expect(worst).toBeGreaterThanOrEqual(BLOOM_REACH);
  });
});
