/**
 * Contamination decays on its OWN clock, and takes only its OWN earth with it.
 *
 * A contamination event owns a slot (see `land-radiation-slots.test.ts`); that slot's zones carry its
 * clock, and when the last of them runs out the earth it poisoned becomes ordinary soil again. Both
 * halves of that sentence used to be wrong, because decay was expressed as "clear every hot pixel
 * within the dead zone's radius" rather than "clear this event's earth":
 *
 *  - It MISSED its own coat. The disc is centred on the surface while the fallout hugs the face of a
 *    bowl carved below it, so at equal radius the coat lies just outside the disc — measured at zero
 *    of 6836 pixels reached. Contaminated ground therefore never cooled: long after its glow had
 *    faded out it was still hot to `radiationAt`, still damaging anything standing on it, for the
 *    rest of the match.
 *  - It HIT everybody else's. Nothing checked the slot, so any neighbouring crater whose earth fell
 *    inside the dead zone's disc was decontaminated along with it, at whatever brightness it was
 *    glowing — measured wiping coats still at 59% and 100% brightness. On a map with a few
 *    overlapping craters that reads as live radiation vanishing outright.
 */
import {describe, it, expect} from 'vitest';
import {landPriv} from './_internals';
import {CLand} from '../src/core/CLand';

const SOLID = 0xff3c5a1e >>> 0;
const RED: [number, number, number] = [255, 46, 20];
const BLUE: [number, number, number] = [40, 90, 255];

function flatLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = landPriv(land);
  const px = new Uint32Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = surf;
    for (let y = surf; y < H; y++) px[y * W + x] = SOLID;
  }
  p.m_pixels = px;
  p.m_material = new Uint8Array(W * H);
  return land;
}

function settle(land: CLand): void {
  const p = landPriv(land);
  for (let i = 0; i < 600 && p.m_radSpecks.length > 0; i++) land.update(1 / 60);
}

/** Hot pixels per slot — the earth the map actually still holds. */
function hotBySlot(land: CLand): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of landPriv(land).m_material) {
    if (!((b >> 1) & 0x0f)) continue;
    const slot = (b >> 5) & 0x07;
    out.set(slot, (out.get(slot) ?? 0) + 1);
  }
  return out;
}

/** Run until every zone on `slot` has expired (or give up). */
function burnOut(land: CLand, slot: number): boolean {
  const p = landPriv(land);
  for (let i = 0; i < 60 * 600; i++) {
    land.update(1 / 60);
    if (!p.m_radParticles.some(z => z.slot === slot)) return true;
  }
  return false;
}

describe('CLand — contamination decays on its own clock', () => {
  it('an event that burns out really does leave the ground clean', () => {
    const surf = 150;
    const land = flatLand(600, 300, surf);

    land.beginRadiationEvent();
    // Carved first, so the coat lines a real bowl — the geometry the disc could never reach.
    land.carveDiscCollapse(300, surf + 10, 90);
    land.blastIradiate(300, land.getHeightAt(300), 90, 12, 4, RED);
    settle(land);

    const slot = [...hotBySlot(land).keys()][0];
    expect(hotBySlot(land).get(slot)).toBeGreaterThan(500); // a real coat went down
    expect(land.radiationAt(300)).toBe(true); // …and it is damaging

    expect(burnOut(land, slot)).toBe(true);

    // Its clock ran out, so this is ordinary soil again — not merely invisible. Left hot, a tank
    // parked here would keep taking fallout damage from a crater that stopped glowing minutes ago.
    expect(hotBySlot(land).get(slot) ?? 0).toBe(0);
    expect(land.radiationAt(300)).toBe(false);
  });

  it('…and takes NOTHING from the crater next to it', () => {
    const surf = 150;
    const land = flatLand(800, 300, surf);

    // A short-lived blast…
    land.beginRadiationEvent();
    land.carveDiscCollapse(360, surf + 10, 90);
    land.blastIradiate(360, land.getHeightAt(360), 90, 12, 4, RED);
    settle(land);
    const oldSlot = [...hotBySlot(land).keys()][0];

    // …and a long-lived one landing right beside it, well inside the first one's radius.
    land.beginRadiationEvent();
    land.carveDiscCollapse(420, land.getHeightAt(420) + 10, 60);
    land.blastIradiate(420, land.getHeightAt(420), 60, 12, 400, BLUE);
    settle(land);
    const newSlot = [...hotBySlot(land).keys()].find(s => s !== oldSlot)!;
    const newBefore = hotBySlot(land).get(newSlot)!;
    expect(newBefore).toBeGreaterThan(300);

    expect(burnOut(land, oldSlot)).toBe(true);

    // The neighbour is untouched and still burning: its clock is its own. Cleared by radius instead
    // of by slot, it lost most of its coat here while still glowing at full brightness.
    expect(hotBySlot(land).get(newSlot) ?? 0).toBe(newBefore);
    expect(landPriv(land).m_radParticles.some(z => z.slot === newSlot)).toBe(true);
  });

  it('a cluster keeps its ground until the LAST of its zones runs out', () => {
    const surf = 150;
    const land = flatLand(800, 300, surf);

    // One event, several detonations — a cluster weapon. They share a slot, so they share the
    // clock, and the earliest zone to expire must not strip the earth the later ones still own.
    land.beginRadiationEvent();
    for (let k = 0; k < 3; k++) {
      const x = 300 + k * 60;
      land.carveDiscCollapse(x, surf + 8, 50);
      land.blastIradiate(x, land.getHeightAt(x), 50, 12, 4 + k * 6, RED);
      settle(land);
    }
    const slot = [...hotBySlot(land).keys()][0];
    const coat = hotBySlot(land).get(slot)!;
    const p = landPriv(land);
    expect(p.m_radParticles.length).toBe(3);

    // Step until only the longest zone is left — the earth must all still be there.
    for (let i = 0; i < 60 * 600 && p.m_radParticles.length > 1; i++) land.update(1 / 60);
    expect(p.m_radParticles.length).toBe(1);
    expect(hotBySlot(land).get(slot)).toBe(coat);

    expect(burnOut(land, slot)).toBe(true);
    expect(hotBySlot(land).get(slot) ?? 0).toBe(0);
  });
});
