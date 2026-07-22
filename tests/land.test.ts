/**
 * Deterministic logic tests for CLand terrain deformation.
 */
import {describe, it, expect} from 'vitest';

import {CLand} from '../src/core/CLand';

type Priv = {m_particles: unknown[]};
const debrisLeft = (land: CLand): number => (land as unknown as Priv).m_particles.length;

describe('CLand terrain', () => {
  it('a crater lowers the surface within its radius and leaves terrain outside untouched', () => {
    const land = new CLand(1080, 400);
    land.generateRandomTerrain(12345);
    const cx = 540;
    const sy = land.getHeightAt(cx);
    const farBefore = land.getHeightAt(cx + 200);

    land.blastCircle(cx, sy, 60);

    // screen-Y down: a crater makes the surface number LARGER (lower on screen).
    expect(land.getHeightAt(cx)).toBeGreaterThan(sy); // crater lowers the surface at its centre
    let lowered = 0;
    for (let x = cx - 55; x <= cx + 55; x++) if (land.getHeightAt(x) > sy - 1) lowered++;
    expect(lowered).toBeGreaterThanOrEqual(90); // crater lowers a wide span
    expect(land.getHeightAt(cx + 200)).toBe(farBefore); // terrain far from the crater is untouched
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
});
