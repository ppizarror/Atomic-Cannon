/**
 * There cannot be radiation floating in air.
 *
 * The settled coat is drawn by spreading each hot grain's dot onto its neighbours — that bleed is
 * what softens the join between contaminated earth and the ground around it. The bleed has to check
 * three things: bounds, that the target is not already hot, and — the one that matters here — that
 * there is any GROUND under the target at all. Without that last check, every grain lying on the
 * surface bleeds its dot straight upward into the sky.
 *
 * On flat ground that is a 1-2px halo nobody notices. Along a cliff edge or a fresh crater rim —
 * where the terrain stops abruptly and every grain on that line is a surface grain — it becomes a
 * continuous band of glow hanging off the terrain with nothing underneath it, and it reads as a bug
 * in something else entirely: a rocket fired into contaminated ground looks as though it failed to
 * clean it, when the earth (and its radiation) went correctly and what is left is the halo bleeding
 * off the rim the rocket just cut.
 *
 * The invariant is the simple one: a lit pixel of the glow layer must sit on solid terrain. This
 * exercises the REAL bake through `draw()` — the headless canvas stub captures what `putImageData`
 * writes — because the property lives in the compositing, not in the radiation channel, where every
 * data-level assertion in the suite passes happily either way.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';
import {makeCanvas, type MockImage} from './_dom';
import {landPriv} from './_internals';

const SOLID = 0xff3c5a1e >>> 0;

/** A land with a sheer CLIFF: high ground on the left, a drop at `cliffX`, low ground on the right.
 *  The edge is the case that matters — it is a column of surface grains stacked vertically. */
function cliffLand(W: number, H: number, cliffX: number, hi: number, lo: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = landPriv(land);
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
  const p = landPriv(land);
  for (let i = 0; i < 500 && p.m_radSpecks.length > 0; i++) land.update(1 / 60);
}

/**
 * Every lit texel of the baked glow, in WORLD coordinates — BOTH passes.
 *
 * The halo counts. It is the same light spread wide and dim, and letting a scaler do the blur
 * (shrink the layer, blow it back up, let its filtering smear it) puts it outside this invariant
 * entirely: the sharp layer refuses to light air, and then the bloom smears that same light ~40px
 * off a crater wall into the open bowl. Baking it is what brings it under the rule, and sweeping it
 * here is what keeps it there.
 */
function litTexels(land: CLand): {x: number; y: number}[] {
  const p = landPriv(land);
  return litIn(land, [...p.m_radGlowCanvas, ...p.m_radGlowBloom]);
}

/** The lit texels of one set of baked tiles, in WORLD coordinates. */
function litIn(land: CLand, tiles: (HTMLCanvasElement | undefined)[]): {x: number; y: number}[] {
  const p = landPriv(land);
  const out: {x: number; y: number}[] = [];
  for (const cv of tiles) {
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

/** Lit texels with no terrain under them — the whole point of this file. */
function inAir(land: CLand, lit: {x: number; y: number}[]): {x: number; y: number}[] {
  const p = landPriv(land);
  const W = p.m_nWidth,
    H = p.m_nHeight;
  const px = p.m_pixels;
  return lit.filter(t => {
    if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) return true; // off-world is air too
    return (px[t.y * W + t.x] & 0xff000000) === 0; // lit, but no terrain there
  });
}

describe('CLand — the radiation glow never lights empty space', () => {
  it('a coat along a cliff edge does not glow off into the sky', () => {
    const W = 400,
      H = 300,
      cliffX = 200;
    const land = cliffLand(W, H, cliffX, 120, 220); // 100px sheer drop

    // Contaminate the high ground right up to the edge.
    land.blastIradiate(cliffX - 40, 120, 60, 12, 30, [255, 46, 20]);
    settleFallout(land);

    land.draw(makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D);

    const lit = litTexels(land);
    expect(lit.length).toBeGreaterThan(50); // the coat really did bake something
    expect(inAir(land, lit)).toHaveLength(0);
  });

  it('a fresh crater rim does not leave a halo hanging over the hole', () => {
    const W = 400,
      H = 300,
      surf = 150;
    const land = cliffLand(W, H, W, surf, surf); // flat

    land.blastIradiate(200, surf, 90, 12, 30, [255, 46, 20]);
    settleFallout(land);
    // Blow a hole through the middle of the contamination — the rocket case. The earth it removes
    // takes its radiation with it, and the new rim must not glow into the void it just opened.
    land.carveDiscCollapse(200, surf + 8, 40, true, false, true);
    for (let i = 0; i < 200; i++) land.update(1 / 60);

    land.draw(makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D);

    expect(inAir(land, litTexels(land))).toHaveLength(0);
  });

  it('a carve rebuilds the layer THAT frame, however recently it was baked', () => {
    const W = 400,
      H = 300,
      surf = 150;
    const land = cliffLand(W, H, W, surf, surf); // flat
    const ctx = makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D;

    land.blastIradiate(200, surf, 90, 12, 30, [255, 46, 20]);
    settleFallout(land);
    land.draw(ctx); // baked, and the rebuild clock is now at zero

    // Fallout merely ACCUMULATING is allowed to wait for the next scheduled rebuild, because a
    // thicker coat does not make the drawn one wrong. Cutting is the opposite: this hole has to
    // appear in the layer immediately or the next frame draws the old coat over ground that has
    // just been removed — glow hanging in a fresh crater, which is the whole failure this file
    // exists for. Drawn with NO `update()` in between, so nothing but urgency can trigger the bake.
    land.carveDiscCollapse(200, surf + 8, 45, true, false, true);
    land.draw(ctx);

    const lit = litTexels(land);
    expect(lit.length).toBeGreaterThan(50); // still a coat around the hole
    expect(inAir(land, lit)).toHaveLength(0);
  });

  it('the soft HALO obeys the same rule as the specks it sits under', () => {
    const W = 400,
      H = 300,
      surf = 150;
    const land = cliffLand(W, H, W, surf, surf); // flat
    const p = landPriv(land);

    // Coat the ground, then blow a crater through the middle of it — the reported case. The walls
    // it leaves are near-vertical and hot on both faces, which is the geometry that makes a
    // ground-blind blur spray glow sideways into the open bowl.
    land.blastIradiate(200, surf, 90, 12, 30, [255, 200, 0]);
    settleFallout(land);
    land.carveDiscCollapse(200, surf + 8, 45, true, false, true);
    for (let i = 0; i < 200; i++) land.update(1 / 60);

    land.draw(makeCanvas(W, H).getContext('2d') as CanvasRenderingContext2D);

    // The halo is REAL — it was baked and it is bright. Without this the sweep below would pass on
    // an empty buffer, which is exactly how a bloom that lights the sky slips past a test.
    const halo = litIn(land, p.m_radGlowBloom);
    expect(halo.length).toBeGreaterThan(200);
    // Wider than the specks that cast it, or it is not a halo at all.
    expect(halo.length).toBeGreaterThan(litIn(land, p.m_radGlowCanvas).length);
    // …and every texel of it has earth beneath it. Live-blitted through a downscale and back up,
    // this ran to hundreds of texels of glow hanging in the crater's airspace.
    expect(inAir(land, halo)).toHaveLength(0);
  });
});
