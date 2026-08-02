/**
 * Regression: a fill (Dirt weapon, or a crater's own ejecta) piled over irradiated ground must BURY
 * the radiation, and a carve must take it away — never leave it floating on ground it no longer
 * belongs to.
 *
 * Radioactivity is a PROPERTY OF THE TERRAIN — bits 1-7 of the per-pixel material byte, alongside the
 * dirt tag in bit 0 — not a cloud of particles hovering near it. Fallout specks are only the fall: on landing a grain stamps the
 * channel and is recycled. That coupling is the point. It used to live purely in the specks, at
 * absolute positions with no relationship to the ground, so four separate call sites (crater disc,
 * beam carve, column filter, the fill) each had to GUESS what a terrain edit did to it — and every
 * guess was wrong in some direction: fallout stranded in bands over ground that merely happened to
 * survive, deposited dirt carried no radiation at all, and lifting buried grains back to the surface
 * dragged them up through the earth as a crater refilled.
 *
 * Now there is nothing to guess. Every terrain edit routes through `setColumnTop`, which clears the
 * channel for the pixels it touches: earth arriving is clean, earth leaving takes its radioactivity
 * with it. These tests drive that REAL edit path for the same reason — poking `m_arrHeights`
 * directly (as the previous version of this file did) moves the ground without moving the terrain,
 * which is precisely the decoupling the channel exists to prevent.
 */
import {describe, it, expect} from 'vitest';
import {landPriv} from './_internals';
import {CLand} from '../src/core/CLand';

function flatLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = landPriv(land);
  for (let x = 0; x < W; x++) p.m_arrHeights[x] = surf;
  return land;
}

/** Run until every airborne grain has landed and stamped the terrain. */
function settleFallout(land: CLand): void {
  const p = landPriv(land);
  for (let i = 0; i < 400 && p.m_radSpecks.length > 0; i++) land.update(1 / 60);
}

/** Total radioactivity recorded in a column, at any depth. The material byte packs the dirt tag in
 *  bit 0 and how radioactive that pixel of earth is in bits 1-7, so this reads past the tag. */
function columnHeat(land: CLand, col: number): number {
  const p = landPriv(land);
  const mat = p.m_material;
  if (!mat) return 0;
  let sum = 0;
  for (let y = 0; y < p.m_nHeight; y++) sum += mat[y * p.m_nWidth + col] >>> 1;
  return sum;
}

describe('CLand — radioactivity belongs to the earth', () => {
  it('fallout that lands is recorded in the terrain, not held as particles', () => {
    const land = flatLand(300, 300, 150);
    const p = landPriv(land);

    land.blastIradiate(150, 150, 40, 12, 6, [255, 46, 20]);
    settleFallout(land);

    expect(p.m_radSpecks.length).toBe(0); // every grain landed and became ground
    expect(columnHeat(land, 150)).toBeGreaterThan(0);
    expect(land.radiationAt(150)).toBe(true);
  });

  it('a fill piled over the fallout buries it — the fresh dirt on top is clean', () => {
    const land = flatLand(300, 300, 150);
    const p = landPriv(land);

    land.blastIradiate(150, 150, 40, 12, 6, [255, 46, 20]);
    settleFallout(land);
    const buried = columnHeat(land, 150);
    expect(buried).toBeGreaterThan(0);

    // Pile 30px of dirt over the whole coat, through the real edit path.
    for (let x = 0; x < 300; x++) land.setColumnTop(x, p.m_arrHeights[x] - 30);

    // Nothing radioactive is reachable from the new surface — it is under 30px of clean earth.
    expect(land.radiationAt(150)).toBe(false);
    // …but it was BURIED, not decontaminated. The hot earth is still down there, untouched, so
    // digging back down to it would expose it again.
    expect(columnHeat(land, 150)).toBe(buried);
  });

  it('a crater carves the radiation out with the earth it removes', () => {
    const land = flatLand(300, 300, 150);
    const p = landPriv(land);

    land.blastIradiate(150, 150, 40, 12, 6, [255, 46, 20]);
    settleFallout(land);
    expect(columnHeat(land, 150)).toBeGreaterThan(0);

    // Cut the ground away well below the coat, through the real edit path.
    for (let x = 0; x < 300; x++) land.setColumnTop(x, p.m_arrHeights[x] + 60);

    // Gone with the earth — nothing radioactive left hanging above the new surface.
    expect(columnHeat(land, 150)).toBe(0);
    expect(land.radiationAt(150)).toBe(false);
  });
});
