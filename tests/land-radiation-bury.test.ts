/**
 * Regression: a fill (Dirt weapon) fired over an irradiated crater must BURY the radiation, not
 * push it up onto the fresh dirt.
 *
 * The original fixes a settled fallout speck's `y` at settle time and never re-reads the surface —
 * so raising the ground over it leaves it buried in place (`FUN_004a52b0`: settle stamps an absolute
 * y; a settled speck is only *removed* when the surface drops BELOW it, never lifted when it rises).
 * Our port used to re-cling each settled speck to `surface − rise` every frame, which rode the
 * fallout up on top of any deposit. Now settled specks hold an absolute y: a fill buries them (hidden
 * on draw), a crater lowering the ground beneath them culls them.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';

type Priv = {
  m_arrHeights: Int16Array;
  m_radSpecks: {x: number; y: number; settled: boolean; rise: number}[];
  m_nWidth: number;
  m_nHeight: number;
  getHeightAt(col: number): number;
};

function flatLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as Priv;
  for (let x = 0; x < W; x++) p.m_arrHeights[x] = surf;
  return land;
}

/** Settle every airborne speck onto the surface. */
function settleSpecks(land: CLand): void {
  const p = land as unknown as Priv;
  for (let i = 0; i < 200 && p.m_radSpecks.some(s => !s.settled); i++) land.update(1 / 60);
}

describe('CLand — a fill buries the radiation, never lifts it', () => {
  it('settled specks hold an absolute y when the ground is raised over them', () => {
    const W = 300,
      H = 300,
      surf = 150;
    const land = flatLand(W, H, surf);
    const p = land as unknown as Priv;

    land.blastIradiate(150, surf, 40, 12, 6, [255, 46, 20]);
    settleSpecks(land);
    const settled = p.m_radSpecks.filter(s => s.settled);
    expect(settled.length).toBeGreaterThan(0);
    const before = settled.map(s => s.y);

    // Raise the whole terrain by 30px (simulate a dirt fill piling over the fallout).
    for (let x = 0; x < W; x++) p.m_arrHeights[x] = surf - 30;
    land.update(1 / 60);

    // Every still-live settled speck kept its ABSOLUTE y — none climbed with the surface.
    for (const s of p.m_radSpecks) {
      if (!s.settled) continue;
      const orig = before.shift();
      if (orig === undefined) break;
      expect(s.y).toBe(orig); // unchanged — buried in place, not lifted onto the new dirt
      expect(s.y).toBeGreaterThan(surf - 30); // and it now sits BELOW the raised surface
    }
  });

  it('a crater dropping the ground beneath a settled speck culls it (no mid-air fallout)', () => {
    const W = 300,
      H = 300,
      surf = 150;
    const land = flatLand(W, H, surf);
    const p = land as unknown as Priv;

    land.blastIradiate(150, surf, 40, 12, 6, [255, 46, 20]);
    settleSpecks(land);
    const settledBefore = p.m_radSpecks.filter(s => s.settled).length;
    expect(settledBefore).toBeGreaterThan(0);

    // Drop the whole surface far below the settled coat (a crater carving the ground away).
    for (let x = 0; x < W; x++) p.m_arrHeights[x] = surf + 60;
    land.update(1 / 60);

    // The stranded settled specks were culled — none left hanging above the new surface.
    const stranded = p.m_radSpecks.filter(
      s => s.settled && s.y < p.getHeightAt(Math.floor(s.x)) - 8,
    );
    expect(stranded.length).toBe(0);
  });
});
