/**
 * Deterministic logic tests for CLand terrain deformation.
 */
import {describe, it, expect} from 'vitest';

import {CLand} from '../src/core/CLand';
import {makeCanvas} from './_dom';
import {landPriv} from './_internals';

const debrisLeft = (land: CLand): number => landPriv(land).m_spoil.length;

describe('CLand terrain', () => {
  it('a crater lowers the surface within its radius and leaves terrain outside untouched', () => {
    const land = new CLand(1080, 400);
    land.generateRandomTerrain(12345);
    const cx = 540;
    const sy = land.getHeightAt(cx);
    const farBefore = land.getHeightAt(cx + 200);

    land.carveDiscCollapse(cx, sy, 60);

    // screen-Y down: a crater makes the surface number LARGER (lower on screen).
    expect(land.getHeightAt(cx)).toBeGreaterThan(sy); // crater lowers the surface at its centre
    let lowered = 0;
    for (let x = cx - 55; x <= cx + 55; x++) if (land.getHeightAt(x) > sy - 1) lowered++;
    expect(lowered).toBeGreaterThanOrEqual(90); // crater lowers a wide span
    expect(land.getHeightAt(cx + 200)).toBe(farBefore); // terrain far from the crater is untouched
  });

  it('carveDiscCollapse ragged=true gives an IRREGULAR rim; smooth gives a clean circle', () => {
    // The unified crater primitive: `ragged` (explosion weapons) wobbles the disc radius per column;
    // smooth (cleaner/digger) cuts a clean circle. Measure column-to-column variation of the carved
    // floor — the ragged crater must vary more than the smooth one (but neither leaves standing nails).
    const floorVariation = (ragged: boolean): number => {
      const land = new CLand(600, 400);
      const h = new Int16Array(600);
      h.fill(200);
      land.initFromArray(h, 1, 1);
      land.carveDiscCollapse(300, 200, 50, false, ragged); // slump OFF so we read the raw disc profile
      let sumAbsDiff = 0;
      for (let x = 255; x < 345; x++) sumAbsDiff += Math.abs(land.getHeightAt(x) - land.getHeightAt(x - 1));
      return sumAbsDiff;
    };
    const smooth = floorVariation(false);
    const rough = floorVariation(true);
    expect(rough).toBeGreaterThan(smooth); // ragged rim is bumpier than the clean circle
  });

  it('a crater with a FRACTIONAL radius carves exactly like an integer one', () => {
    // `blastCircle`'s column loop has to start on an INTEGER column. A radius that is not a whole
    // number (a weapon radius × a non-integer blast scale, e.g. 130×1.47≈191.1) makes an `x -
    // nRadius` start fractional, so the loop steps through fractional `dx`, `m_arrHeights[dx]` (a
    // TypedArray) reads `undefined`, `craterBottom > undefined` is false — and the crater carves
    // NOTHING, which surfaces as cleaners that "don't clean".
    const land = new CLand(1080, 400);
    land.generateRandomTerrain(12345);
    const cx = 540;
    const sy = land.getHeightAt(cx);

    land.carveDiscCollapse(cx, sy, 60.7); // ← FRACTIONAL radius, the exact trigger

    expect(land.getHeightAt(cx)).toBeGreaterThan(sy); // it MUST still lower the surface
    let lowered = 0;
    for (let x = cx - 55; x <= cx + 55; x++) if (land.getHeightAt(x) > sy) lowered++;
    expect(lowered).toBeGreaterThanOrEqual(90); // a wide swath carved, exactly like an integer radius
  });

  it('settled debris raises the surface where chunks land and removes nothing', () => {
    const land = new CLand(1080, 400);
    land.generateRandomTerrain(999);
    const cx = 300;
    const before: number[] = [];
    for (let x = cx - 90; x <= cx + 90; x++) before.push(land.getHeightAt(x));
    land.addShowerParticles(cx, land.getHeightAt(cx), 2500, 60);
    for (let i = 0; i < 500 && debrisLeft(land) > 0; i++) land.update(1 / 60);
    let raised = 0,
      dug = 0;
    for (let i = 0; i < before.length; i++) {
      const now = land.getHeightAt(cx - 90 + i);
      if (now < before[i] - 1) raised++; // smaller Y = higher = added earth
      if (now > before[i] + 1) dug++; // never removes
    }
    expect(raised).toBeGreaterThanOrEqual(10); // settled debris raises the surface
    expect(dug).toBe(0); // settled debris removes nothing
  });

  it('dispose() releases the world buffers so a re-sized land never holds two sets at once', () => {
    const land = new CLand(1200, 400);
    land.generateFlat();
    land.addShowerParticles(600, 260, 400, 40); // debris in flight
    type World = {
      m_terrainCanvas: HTMLCanvasElement | null;
      m_backdropCanvas: HTMLCanvasElement | null;
      m_debugCanvas: HTMLCanvasElement | null;
      m_pixels: unknown;
      m_material: unknown;
      m_spoil: unknown[];
    };
    const p = land as unknown as World;
    // Headless tests never call draw(), so stand in the baked world-sized buffers by hand.
    p.m_terrainCanvas = makeCanvas(1200, 400);
    p.m_backdropCanvas = makeCanvas(1200, 400);
    p.m_pixels = new Uint32Array(1200 * 400);
    p.m_material = new Uint8Array(1200 * 400);
    expect(p.m_spoil.length).toBeGreaterThan(0);

    land.dispose();

    // Backing stores zeroed + references dropped → the old footprint is reclaimable at once.
    expect(p.m_terrainCanvas).toBeNull();
    expect(p.m_backdropCanvas).toBeNull();
    expect(p.m_debugCanvas).toBeNull();
    expect(p.m_pixels).toBeNull();
    expect(p.m_material).toBeNull();
    expect(p.m_spoil.length).toBe(0); // in-flight debris dropped too
  });

  it('the view tile spans only the visible width and clamps to the world edges', () => {
    const land = new CLand(4000, 400);
    type Tile = {
      setViewport(camX: number, viewW: number): void;
      tileSpanW(): number;
      tileSpanX(): number;
    };
    const t = land as unknown as Tile;

    t.setViewport(1000, 800); // mid-scroll: tile is view-wide, offset == camX
    expect(t.tileSpanW()).toBe(800);
    expect(t.tileSpanX()).toBe(1000);

    t.setViewport(3800, 800); // past the right edge → clamp so tile stays inside the world
    expect(t.tileSpanX()).toBe(3200); // 4000 − 800

    t.setViewport(0, 0); // no viewport set (tests / unset) → tile the WHOLE world
    expect(t.tileSpanW()).toBe(4000);
    expect(t.tileSpanX()).toBe(0);

    const small = new CLand(600, 400) as unknown as Tile;
    small.setViewport(0, 800); // world narrower than the view → tile caps at the world width
    expect(small.tileSpanW()).toBe(600);
    expect(small.tileSpanX()).toBe(0);
  });
});
