/**
 * One blast's fallout must not repaint, revive, or erase another's.
 *
 * Asking the LIVE ZONES what colour each hot pixel is — taking the nearest one — leaves the ground
 * with no memory of what contaminated it: fire a hydrogen weapon (blue fallout), then a uranium one
 * (red) beside it, and once the hydrogen zone is gone every hot pixel on the map has only the
 * uranium zone left to ask, so the whole blue coat turns red, not just where the two met.
 *
 * Identity is a property of the pixel instead, like its radioactivity: the material byte carries a
 * 3-bit SLOT (bit 0 dirt tag, bits 1-4 intensity, bits 5-7 slot). A slot is one DETONATION — its
 * colour and its clock — not one colour, because two uranium craters an hour apart are not the same
 * contamination: sharing a slot flares the older one back to full brightness the moment the newer
 * one lands, and keeps it from ever going out.
 */
import {describe, it, expect} from 'vitest';
import {landPriv} from './_internals';
import {CLand} from '../src/core/CLand';

const BLUE: [number, number, number] = [40, 90, 255];
const RED: [number, number, number] = [255, 46, 20];

const radOf = (b: number): number => (b >>> 1) & 15;
const slotOf = (b: number): number => (b >>> 5) & 7;

function flatLand(W: number, H: number, surf: number): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = landPriv(land);
  for (let x = 0; x < W; x++) p.m_arrHeights[x] = surf;
  return land;
}

function settleFallout(land: CLand): void {
  const p = landPriv(land);
  for (let i = 0; i < 500 && p.m_radSpecks.length > 0; i++) land.update(1 / 60);
}

/** The colours actually recorded in a column's earth, via each pixel's slot. */
function columnColours(land: CLand, col: number): string[] {
  const p = landPriv(land);
  const mat = p.m_material;
  if (!mat) return [];
  const seen = new Set<string>();
  for (let y = 0; y < p.m_nHeight; y++) {
    const b = mat[y * p.m_nWidth + col];
    if (!radOf(b)) continue; // not radioactive
    const rgb = p.m_radSlotRGB[slotOf(b)];
    if (rgb) seen.add(rgb.join(','));
  }
  return [...seen];
}

/** The distinct slots recorded in a column's earth. */
function columnSlots(land: CLand, col: number): number[] {
  const p = landPriv(land);
  const mat = p.m_material;
  if (!mat) return [];
  const seen = new Set<number>();
  for (let y = 0; y < p.m_nHeight; y++) {
    const b = mat[y * p.m_nWidth + col];
    if (radOf(b)) seen.add(slotOf(b));
  }
  return [...seen];
}

describe('CLand — irradiated earth keeps the identity that contaminated it', () => {
  it('a second blast in a different colour does not repaint the first', () => {
    const W = 600,
      H = 300,
      surf = 150;
    const land = flatLand(W, H, surf);

    // Hydrogen: blue fallout on the left.
    land.blastIradiate(150, surf, 45, 12, 30, BLUE);
    settleFallout(land);
    expect(columnColours(land, 150)).toEqual([BLUE.join(',')]);

    // Uranium: red fallout on the right, close enough that its disc reaches the blue zone.
    land.blastIradiate(260, surf, 45, 12, 30, RED);
    settleFallout(land);

    // The blue ground is still blue…
    expect(columnColours(land, 150)).toEqual([BLUE.join(',')]);
    // …and the red ground is red. Two coats, two colours, on one map.
    expect(columnColours(land, 260)).toEqual([RED.join(',')]);
  });

  it('the blue coat survives its own zone expiring under a red one', () => {
    const W = 600,
      H = 300,
      surf = 150;
    const land = flatLand(W, H, surf);
    const p = landPriv(land);

    land.blastIradiate(200, surf, 45, 12, 30, BLUE);
    settleFallout(land);
    expect(columnColours(land, 200)).toEqual([BLUE.join(',')]);

    // Drop every live zone — the case that leaves the ground with nothing to ask but the newest
    // blast. The recorded colour is in the earth, so it does not depend on the zones at all.
    p.m_radParticles.length = 0;
    // Far enough that its own fallout cannot reach column 200 — this is about the RECORDED identity
    // surviving, not about two coats overlapping (where mixing is correct and expected).
    land.blastIradiate(360, surf, 45, 12, 30, RED);
    settleFallout(land);

    expect(columnColours(land, 200)).toEqual([BLUE.join(',')]);
  });

  it('every blast gets its OWN slot, even fired twice in the same colour', () => {
    const land = flatLand(900, 300, 150);

    land.blastIradiate(150, 150, 40, 12, 30, BLUE);
    settleFallout(land);
    const first = columnSlots(land, 150);

    land.blastIradiate(600, 150, 40, 12, 30, BLUE); // same weapon, far away
    settleFallout(land);
    const second = columnSlots(land, 600);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Same colour, different detonation → different slot, so the first crater keeps fading on its
    // own clock instead of being relit by the second.
    expect(second[0]).not.toBe(first[0]);
  });

  it('each crater keeps its own clock — a later blast neither revives nor deletes it', () => {
    const land = flatLand(900, 300, 150);
    const p = landPriv(land);

    land.blastIradiate(150, 150, 40, 12, 30, BLUE);
    settleFallout(land); // A ages while its fallout comes down
    const slotA = columnSlots(land, 150)[0];
    const zA = p.m_radParticles.find(z => z.slot === slotA)!;
    const agedA = zA.timeRemaining;
    // Against the zone's OWN duration, not a copy of the linger multiplier — the point is that time
    // has passed, and pinning the expected total here just breaks when that constant is tuned.
    expect(agedA).toBeLessThan(zA.duration);

    land.blastIradiate(600, 150, 40, 12, 30, BLUE);

    const zoneA = p.m_radParticles.find(z => z.slot === slotA);
    // A survives B — a later shell beside an old crater must not delete it and take the whole
    // coat's glow with it — and A's clock only ever runs DOWN. It is not reset by B.
    expect(zoneA).toBeDefined();
    expect(zoneA!.timeRemaining).toBeLessThanOrEqual(agedA);
    // …while B starts fresh. Two clocks, not one shared maximum.
    const slotB = columnSlots(land, 600)[0] ?? slotA + 1;
    expect(p.m_radParticles.find(z => z.slot === slotB)!.timeRemaining).toBeGreaterThan(agedA);
  });

  it('a crater carved through a zone leaves the surrounding irradiated soil hot', () => {
    const land = flatLand(900, 300, 150);

    land.blastIradiate(450, 150, 120, 12, 30, RED); // a wide zone
    settleFallout(land);
    expect(columnColours(land, 380)).toEqual([RED.join(',')]);

    // A small shell lands dead centre. It takes the earth it excavates and blows the loose grains
    // out of its own disc — it must NOT decontaminate, or stop the clock on, the soil around it.
    land.carveDiscCollapse(450, 150, 30, true, false, true);

    expect(columnColours(land, 380)).toEqual([RED.join(',')]); // still hot, still red
    expect(land.radiationAt(380)).toBe(true); // and still damaging
    expect(land.getRadiationZones().length).toBeGreaterThan(0); // the zone was not deleted
  });

  it('a small blast inside a large one FUSES with it — neither patch is destroyed', () => {
    const land = flatLand(900, 300, 150);

    land.blastIradiate(450, 150, 130, 12, 30, RED); // the big one
    settleFallout(land);
    const bigSlot = columnSlots(land, 450)[0];
    expect(columnSlots(land, 380)).toEqual([bigSlot]);

    land.blastIradiate(450, 150, 35, 12, 30, BLUE); // a small one dead centre of it
    settleFallout(land);

    // Where the small one landed, its own contamination is now on top…
    expect(columnColours(land, 450)).toContain(BLUE.join(','));
    // …and the big one's ground OUTSIDE its footprint is untouched: same slot, same colour, still
    // on its own clock. The two coats sit side by side and composite; the newcomer does not
    // repaint, relight or wipe its neighbour.
    expect(columnSlots(land, 380)).toEqual([bigSlot]);
    expect(columnColours(land, 380)).toEqual([RED.join(',')]);
    expect(land.getRadiationZones()).toHaveLength(2);
  });

  it('recycling a slot ERASES the old blast’s earth rather than recolouring it', () => {
    const land = flatLand(2600, 300, 150);

    // The first blast's slot must be gone — not repainted red — once enough later blasts have run
    // the 8 slots round. Otherwise a long-dead crater lights back up in someone else's colour.
    land.blastIradiate(150, 150, 40, 12, 30, BLUE);
    settleFallout(land);
    expect(columnColours(land, 150)).toEqual([BLUE.join(',')]);

    for (let i = 1; i <= 8; i++) {
      land.blastIradiate(150 + i * 260, 150, 40, 12, 30, RED);
      settleFallout(land);
    }
    expect(columnColours(land, 150)).toEqual([]); // decontaminated, not turned red
  });
});
