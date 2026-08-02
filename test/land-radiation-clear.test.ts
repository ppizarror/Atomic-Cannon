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
import {CParticleSystem} from '../src/core/CParticleSystem';

type Priv = {
  m_pixels: Uint32Array;
  m_material: Uint8Array;
  m_arrHeights: Int16Array;
  m_radParticles: unknown[];
  m_nWidth: number;
  m_nHeight: number;
};

/** A flat land with a REAL pixel buffer so `blastCircle` can actually carve.
 *  The heat wisps live in CParticleSystem now (CLand only decides where fallout fumes), so the
 *  land is wired to one and the tests count wisps there. */
function landWithPixels(
  W: number,
  H: number,
  surfaceY: number,
): {land: CLand; fx: CParticleSystem} {
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
  const fx = new CParticleSystem();
  fx.setBounds(W, H);
  land.setHeatSink(fx);
  return {land, fx};
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
    const {land, fx} = landWithPixels(W, H, surf);

    // Irradiate the middle of the field.
    land.blastIradiate(150, surf, 40, 12, 6, [255, 46, 20]);
    expect(land.getRadiationZones().length).toBe(1);

    // Run frames so the heat "smoke" starts venting off the live zone.
    stepUntil(land, () => fx.heatCount() > 0);
    expect(fx.heatCount()).toBeGreaterThan(0); // it IS smoking

    // Fire a cleaner (earth-remover: blastCircle with coatDirt=false) right over the zone.
    land.carveDiscCollapse(150, surf, 44);

    // The hot EARTH is gone → tanks stop taking fallout damage there. Asserted on the ground, not
    // on the zone list: the zone is the blast's CLOCK and outlives its earth on purpose (deleting it
    // whenever a later shell landed on it was what darkened the coat all around the new crater).
    expect(land.radiationAt(150)).toBe(false);
    // …the existing wisps over the cleared span are wiped…
    expect(fx.heatCount()).toBe(0);

    // …and, crucially, NO new smoke spawns on later frames — a wisp needs hot ground under it, and
    // the cleaner took the ground.
    for (let i = 0; i < 120; i++) land.update(1 / 60);
    expect(fx.heatCount()).toBe(0);
  });

  it('a cleaner OFF to the side leaves an untouched radiation zone smoking', () => {
    const W = 400,
      H = 300,
      surf = 150;
    const {land, fx} = landWithPixels(W, H, surf);

    land.blastIradiate(100, surf, 30, 12, 6, [255, 46, 20]);
    expect(land.getRadiationZones().length).toBe(1);

    // Clean the FAR side — nowhere near the zone at x=100.
    land.carveDiscCollapse(320, surf, 40);

    // The distant zone survives (a cleaner only clears what it actually erased).
    expect(land.getRadiationZones().length).toBe(1);
    stepUntil(land, () => fx.heatCount() > 0);
    expect(fx.heatCount()).toBeGreaterThan(0);
  });

  it('radiationAt reports the visible fallout footprint (drives "Radiation Damage: On")', () => {
    const W = 800,
      H = 300,
      surf = 150;
    const {land} = landWithPixels(W, H, surf);

    land.blastIradiate(400, surf, 60, 12, 6, [255, 46, 20]);
    // Let the specks fly and settle onto the surface.
    for (let i = 0; i < 180; i++) land.update(1 / 60);

    // On the fallout carpet (the blast centre) → irradiated; far outside it → clean ground.
    expect(land.radiationAt(400)).toBe(true);
    expect(land.radiationAt(60)).toBe(false); // far to the left, no specks landed here
    expect(land.radiationAt(760)).toBe(false); // far to the right
  });

  it('a bomb clears radiation only within its blast DISC — not the whole column band', () => {
    const W = 600,
      H = 400,
      surf = 200;
    const {land} = landWithPixels(W, H, surf);
    const specks = (land as unknown as {m_radSpecks: {x: number; y: number}[]}).m_radSpecks;
    const mk = (x: number, y: number) => ({
      x,
      y,
      vx: 0,
      vy: 0,
      age: 0,
      life: 10,
      settled: true,
      size: 1,
      rise: 0,
      phase: 0,
      pw: 1,
      r: 255,
      g: 0,
      b: 0,
    });
    const R = 60,
      cx = 300,
      cy = surf; // blast disc: centre (300, 200), radius 60

    // Two specks the blast REACHES (inside the disc) and two it does NOT — the second pair sits in
    // the same x-band but BELOW the blast line and outside the sphere, which is soil the explosion
    // never touched. (Above the blast line the x-band IS cleared, whether or not it is inside the
    // sphere: the fireball erupts up through that column and takes the settling ash with it. Without
    // that, ash still in the air when a shot lands simply carries on down and re-coats the crater
    // that was meant to have swept it away.)
    specks.push(
      mk(cx, cy), // centre — dist 0 → inside → cleared
      mk(cx + 5, cy - 5), // ~7px from centre → inside → cleared
      mk(cx, cy + 2 * R), // 120px straight down → soil the blast never reached → KEPT
      mk(cx - R * 0.95, cy + R * 0.95), // ~81px away, below the blast line (x-band [240,360]) → KEPT
    );

    land.carveDiscCollapse(cx, cy, R, true, true, true);

    const rem = (land as unknown as {m_radSpecks: {x: number; y: number}[]}).m_radSpecks;
    expect(rem.some(s => s.y === cy + 2 * R)).toBe(true); // deep speck survives (soil not reached)
    expect(rem.some(s => Math.abs(s.x - (cx - R * 0.95)) < 0.5)).toBe(true); // corner speck survives
    expect(rem.some(s => s.x === cx && s.y === cy)).toBe(false); // centre cleared
    expect(rem.some(s => s.x === cx + 5)).toBe(false); // near-centre cleared
  });
});
