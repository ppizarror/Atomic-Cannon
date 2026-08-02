/**
 * Overlapping terrain cuts (e.g. multiple beams over the same span) must NOT leave "floating
 * dirt" — solid pixels stranded in the sky above the surface line.
 *
 * The hazard is a second cut over a column whose overburden is still FALLING: reading the mid-air
 * block top as the surface spawns a concurrent falling block, the two land at independent absolute
 * targets, and whichever sets the surface lower strands the other's pixels above it. `settleFallsIn`
 * finalizes active falls before each re-carve, so every cut starts from settled ground.
 *
 * The pixel-level ops (sliceColumn / falling blocks) only run when `m_pixels` exists — the headless
 * DOM mock no-ops getImageData — so we install a real pixel buffer with solid ground below a flat
 * surface, then assert the invariant: no solid pixel strictly above `heights[col]`.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';

type Px = {
  m_pixels: Uint32Array;
  m_material: Uint8Array;
  m_arrHeights: Int16Array;
  m_nWidth: number;
  m_nHeight: number;
};

/** A flat land with a REAL pixel buffer: solid brown below `surfaceY`, sky above. */
function landWithPixels(W: number, H: number, surfaceY: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as Px;
  const px = new Uint32Array(W * H);
  const mat = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = surfaceY;
    for (let y = surfaceY; y < H; y++) px[y * W + x] = 0xff3c5a1e >>> 0; // opaque solid ground
  }
  p.m_pixels = px;
  p.m_material = mat;
  return land;
}

/** Count solid pixels stranded strictly ABOVE each column's surface height (= floating dirt). */
function floatingPixels(land: CLand): number {
  const p = land as unknown as Px;
  let floating = 0;
  for (let x = 0; x < p.m_nWidth; x++) {
    for (let y = 0; y < p.m_arrHeights[x]; y++) {
      if ((p.m_pixels[y * p.m_nWidth + x] & 0xff000000) !== 0) floating++;
    }
  }
  return floating;
}

function settleAll(land: CLand): void {
  for (let i = 0; i < 400 && (land as unknown as {isSettling(): boolean}).isSettling(); i++)
    land.update(1 / 60);
  land.update(1 / 60); // one more, in case the last landing just cleared
}

describe('CLand — no floating dirt', () => {
  it('overlapping beam slices leave nothing stranded above the surface', () => {
    const W = 200,
      H = 300,
      surf = 120;
    const land = landWithPixels(W, H, surf);

    // First slice: a band well below the surface → the overburden cap starts FALLING.
    land.carveBeamSlice(30, surf + 34, 170, surf + 34, 8);
    land.update(1 / 60); // one frame: blocks are mid-air
    expect(floatingPixels(land)).toBe(0); // a falling block sits AT the surface, never above it

    // Second slice over the SAME span while the first is still in the air — the stranding case.
    land.carveBeamSlice(30, surf + 24, 170, surf + 24, 8);
    land.carveBeamSlice(30, surf + 18, 170, surf + 18, 8); // and a third, for good measure

    settleAll(land);
    expect(floatingPixels(land)).toBe(0); // no dirt left hanging in the sky
  });

  it('a crater over an actively-falling beam cut strands nothing', () => {
    const W = 200,
      H = 300,
      surf = 120;
    const land = landWithPixels(W, H, surf);

    land.carveBeamSlice(40, surf + 34, 160, surf + 34, 10);
    land.update(1 / 60);
    land.carveDiscCollapse(100, surf, 40); // crater over the falling cut

    settleAll(land);
    expect(floatingPixels(land)).toBe(0);
  });

  it('depositing debris on a column with a FALLING overburden block strands nothing', () => {
    // A bomb cuts with `carveDiscCollapse` (falling-block collapse) AND throws DEPOSITING
    // debris. A chunk that settles on a column whose block is still mid-air stamps dirt at the block's
    // CURRENT (high) top; when the block then lands lower, that dirt is left floating above the surface.
    const W = 200,
      H = 300,
      surf = 120;
    const land = landWithPixels(W, H, surf);

    // Detonate BELOW the surface (buried) so the overburden caves in as falling blocks.
    land.carveDiscCollapse(100, surf + 50, 34);
    // …and immediately rain depositing dirt over the same span while those blocks are still falling.
    land.addShowerParticles(100, surf, 1200, 44); // deposit=true (default) → raises columns

    for (let i = 0; i < 8; i++) land.update(1 / 60); // chunks deposit onto the mid-air block tops
    settleAll(land);
    expect(floatingPixels(land)).toBe(0); // no dirt stranded above the settled surface
  });
});
