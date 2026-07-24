/**
 * Regression: erasing irradiated terrain must remove the radiation too.
 *
 * The heat "smoke" wisps are spawned every frame off a LIVE radiation zone (`m_radParticles`).
 * The terrain-erase routines used to wipe only the ground specks, leaving the damage zone alive —
 * so a cleaner fired over an irradiated crater removed the dirt but the ground kept smoking (and
 * kept dealing fallout damage) forever. `clearRadiationSpan` now drops the zones, wisps and specks
 * in the erased span together, so the cleaned ground goes inert.
 */
import {describe, it, expect} from 'vitest';
import {CLand} from '../src/core/CLand';

type Priv = {
  m_pixels: Uint32Array;
  m_material: Uint8Array;
  m_arrHeights: Int16Array;
  m_radParticles: unknown[];
  m_heat: unknown[];
  m_nWidth: number;
  m_nHeight: number;
};

/** A flat land with a REAL pixel buffer so `blastCircle` can actually carve. */
function landWithPixels(W: number, H: number, surfaceY: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as Priv;
  const px = new Uint32Array(W * H);
  const mat = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = surfaceY;
    for (let y = surfaceY; y < H; y++) px[y * W + x] = 0xff3c5a1e >>> 0;
  }
  p.m_pixels = px;
  p.m_material = mat;
  return land;
}

/** Advance frames until the predicate holds (or `max` frames elapse). */
function stepUntil(land: CLand, pred: () => boolean, max = 200): void {
  for (let i = 0; i < max && !pred(); i++) land.update(1 / 60);
}

describe('CLand — erasing terrain clears its radiation', () => {
  it('a cleaner over an irradiated crater stops the smoke and the damage zone', () => {
    const W = 300,
      H = 300,
      surf = 150;
    const land = landWithPixels(W, H, surf);
    const p = land as unknown as Priv;

    // Irradiate the middle of the field.
    land.blastIradiate(150, surf, 40, 12, 6, [255, 46, 20]);
    expect(land.getRadiationZones().length).toBe(1);

    // Run frames so the heat "smoke" starts venting off the live zone.
    stepUntil(land, () => p.m_heat.length > 0);
    expect(p.m_heat.length).toBeGreaterThan(0); // it IS smoking

    // Fire a cleaner (earth-remover: blastCircle with coatDirt=false) right over the zone.
    land.carveDiscCollapse(150, surf, 44);

    // The damage zone is gone → tanks stop taking fallout damage there…
    expect(land.getRadiationZones().length).toBe(0);
    expect(p.m_radParticles.length).toBe(0);
    // …the existing wisps over the cleared span are wiped…
    expect(p.m_heat.length).toBe(0);

    // …and, crucially, NO new smoke spawns on later frames (the zone can't respawn it).
    for (let i = 0; i < 120; i++) land.update(1 / 60);
    expect(p.m_heat.length).toBe(0);
  });

  it('a cleaner OFF to the side leaves an untouched radiation zone smoking', () => {
    const W = 400,
      H = 300,
      surf = 150;
    const land = landWithPixels(W, H, surf);
    const p = land as unknown as Priv;

    land.blastIradiate(100, surf, 30, 12, 6, [255, 46, 20]);
    expect(land.getRadiationZones().length).toBe(1);

    // Clean the FAR side — nowhere near the zone at x=100.
    land.carveDiscCollapse(320, surf, 40);

    // The distant zone survives (a cleaner only clears what it actually erased).
    expect(land.getRadiationZones().length).toBe(1);
    stepUntil(land, () => p.m_heat.length > 0);
    expect(p.m_heat.length).toBeGreaterThan(0);
  });

  it('radiationAt reports the visible fallout footprint (drives "Radiation Damage: On")', () => {
    const W = 800,
      H = 300,
      surf = 150;
    const land = landWithPixels(W, H, surf);

    land.blastIradiate(400, surf, 60, 12, 6, [255, 46, 20]);
    // Let the specks fly and settle onto the surface.
    for (let i = 0; i < 180; i++) land.update(1 / 60);

    // On the fallout carpet (the blast centre) → irradiated; far outside it → clean ground.
    expect(land.radiationAt(400)).toBe(true);
    expect(land.radiationAt(60)).toBe(false); // far to the left, no specks landed here
    expect(land.radiationAt(760)).toBe(false); // far to the right
  });
});
