/**
 * One contamination EVENT owns one radiation slot.
 *
 * The terrain remembers which blast poisoned each pixel in three bits of its material byte — eight
 * slots for the whole map — and claiming one EVICTS whatever earth still holds it. So "how many
 * slots does a shot consume?" is not bookkeeping trivia: consume two and the table burns twice as
 * fast; consume one per detonation and a cluster weapon wipes every other player's contamination off
 * the map the moment it lands. Anthrax (a 7-detonation cluster) is the worst case: claiming per
 * detonation would take fourteen — each submunition one slot to tag the earth it threw and a second
 * inside `blastIradiate` for its zone — and a single Anthrax would erase every Plasma crater in play.
 *
 * The answer is not "make the cluster path pass its slot down". It is that the slot belongs to the
 * EVENT, so `radiationSlot` is idempotent within a turn and there is nothing for any call site — a
 * weapon, a beam, a mine, a trajectory behaviour written next month — to thread through or forget.
 * These tests are therefore written against the real weapons and the real detonation path, not
 * against the allocator: the property that matters is what survives on the map.
 */
import {describe, it, expect} from 'vitest';

import {CLand} from '../src/core/CLand';
import {CShot} from '../src/core/CShot';
import {type CTank} from '../src/core/CTank';
import {WEAPON_DATABASE, getWeapon, weaponName, type CWeapon} from '../src/core/CWeapon';
import {Vec2} from '../src/math/Vec2';
import {weaponDetonate, type ShotWorld} from '../src/core/weapons/WeaponBehavior';
import {landPriv} from './_internals';

const SOLID = 0xff3c5a1e >>> 0;
const SURFACE = 200;

function idxOf(name: string): number {
  const i = WEAPON_DATABASE.findIndex(w => weaponName(w) === name);
  if (i < 0) throw new Error(`weapon not found: ${name}`);
  return i;
}

/** Flat land with real pixels + material, so carving and the radiation channel both behave. */
function land(): CLand {
  const W = 800,
    H = 400;
  const l = new CLand(W, H);
  l.generateFlat();
  const p = landPriv(l);
  const px = new Uint32Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = SURFACE;
    for (let y = SURFACE; y < H; y++) px[y * W + x] = SOLID;
  }
  p.m_pixels = px;
  p.m_material = new Uint8Array(W * H);
  return l;
}

/** The minimum ShotWorld a detonation needs; collects the submunitions it fans out. */
class World implements ShotWorld {
  spawned: CShot[] = [];
  blastScale = 1;
  wind = new Vec2(0, 0); // still air (only homing guidance reads it)
  tanks: CTank[] = []; // no tanks in these tests — the radiation lands on bare terrain

  constructor(public land: CLand) {}

  random(): number {
    return Math.random();
  }

  spawnShot(s: CShot): void {
    this.spawned.push(s);
  }

  explode(): void {}
  shake(): void {}
  ripple(): void {}
  debrisSpray(): void {}
  applyBlast(): void {}
  aimMarker(): void {}
  deployMine(): void {}
  deploySentry(): void {}
  hitSound(): void {}
}

/** Let every grain of fallout land and stamp the channel. */
function settle(l: CLand): void {
  const p = landPriv(l);
  for (let i = 0; i < 600 && p.m_radSpecks.length > 0; i++) l.update(1 / 60);
}

/**
 * Fire one weapon at `x` and detonate its WHOLE family — the round plus every submunition it fans
 * out, recursively. This is the unit a player experiences as "a shot", and the unit the slot system
 * has to treat as one contamination.
 */
function volley(l: CLand, name: string, x: number): void {
  const w: CWeapon = getWeapon(idxOf(name));
  const world = new World(l);
  const shot = new CShot();
  shot.initFromVelocity(new Vec2(x, SURFACE), 0, 120, w.getDamage(), w.getRadius(), null);
  shot.setWeaponIndex(w.getIndex());
  weaponDetonate(shot, w, world);
  // Drain the cluster: children are spawned mid-detonation, and may spawn their own.
  for (let guard = 0; world.spawned.length > 0 && guard < 200; guard++) {
    const child = world.spawned.shift()!;
    weaponDetonate(child, getWeapon(child.getWeaponIndex()), world);
  }
  settle(l);
}

/** Hot pixels of the terrain, counted per slot — what the map actually still holds. */
function hotBySlot(l: CLand): Map<number, number> {
  const p = landPriv(l);
  const out = new Map<number, number>();
  for (const b of p.m_material) {
    const amount = (b >> 1) & 0x0f;
    if (!amount) continue;
    const slot = (b >> 5) & 0x07;
    out.set(slot, (out.get(slot) ?? 0) + 1);
  }
  return out;
}

describe('CLand — one contamination event, one radiation slot', () => {
  it('an Anthrax cluster landing elsewhere leaves an earlier Plasma crater contaminated', () => {
    const l = land();

    l.beginRadiationEvent(); // the Plasma player's turn
    volley(l, 'Plasma', 200);
    const before = hotBySlot(l);
    expect(before.size).toBe(1); // one weapon, one event → one slot
    const [plasmaSlot, plasmaPixels] = [...before][0];
    expect(plasmaPixels).toBeGreaterThan(200); // a real coat, not a few grains

    l.beginRadiationEvent(); // …the next player's turn
    volley(l, 'Anthrax', 600); // 7 detonations, well clear of the Plasma crater

    // The Plasma coat is untouched: Anthrax cut its own hole 400px away and poisoned it, and took
    // nothing else with it. Before the event became the unit, this was 0 — one Anthrax volley
    // claimed fourteen slots and cycled the entire eight-slot table.
    const after = hotBySlot(l);
    expect(after.get(plasmaSlot) ?? 0).toBeGreaterThan(plasmaPixels * 0.9);
    expect(after.size).toBe(2); // Plasma's patch and Anthrax's, and nothing else
  });

  it('every detonation in one volley deposits into the SAME slot — spoil, fallout and zone alike', () => {
    const l = land();
    const p = landPriv(l);

    l.beginRadiationEvent();
    volley(l, 'Anthrax', 400);

    // Seven detonations, one slot on the ground…
    expect(hotBySlot(l).size).toBe(1);
    // …and every damage zone they raised points at that same slot, so the coat has a clock to fade
    // on and earth to be cooled by when it expires. Split across slots, the spoil was tagged with a
    // slot no zone referenced: contaminated ground that never glowed and never decayed.
    const slot = [...hotBySlot(l).keys()][0];
    expect(p.m_radParticles.length).toBeGreaterThan(0);
    expect(p.m_radParticles.every(z => z.slot === slot)).toBe(true);
  });

  it('a later turn poisoning the same colour gets its OWN slot, so the two fade independently', () => {
    const l = land();

    l.beginRadiationEvent();
    volley(l, 'Plasma', 200);
    l.beginRadiationEvent();
    volley(l, 'Plasma', 600);

    // Same weapon, same hue, different events. Sharing here is the fault the per-slot clocks exist
    // to prevent: the older crater would snap back to full brightness the instant the newer one
    // landed, and could not go out while it lived.
    expect(hotBySlot(l).size).toBe(2);
  });

  it('when the table is full, recycling takes a burnt-out slot before a still-glowing one', () => {
    const l = land();
    const p = landPriv(l);

    // Eight distinct events fill the table. One is given a zone that expires almost at once; the
    // rest keep long ones, so age and liveness disagree — which is the case blind LRU gets wrong,
    // since the oldest slot is the one that has been glowing longest. Slots are read as each zone
    // is raised, not afterwards: the short one is gone from the list by then, which is the point.
    const slots: number[] = [];
    for (let i = 0; i < 8; i++) {
      l.beginRadiationEvent();
      const hue: [number, number, number] = [40 + i * 20, 255 - i * 10, 60];
      l.blastIradiate(60 + i * 80, SURFACE, 30, 5, i === 3 ? 0.05 : 600, hue);
      slots.push(p.m_radParticles[p.m_radParticles.length - 1].slot);
      settle(l); // one at a time, as turns resolve — the speck cap trims a simultaneous pile-up
    }
    const doomed = slots[3];
    const kept = slots.filter((_, i) => i !== 3);
    expect(new Set(slots).size).toBe(8); // eight events, eight slots

    for (let i = 0; i < 60; i++) l.update(1 / 60); // the short zone burns out
    expect(p.m_radParticles.some(z => z.slot === doomed)).toBe(false);

    l.beginRadiationEvent();
    l.blastIradiate(400, SURFACE, 30, 5, 600, [10, 20, 200]);
    const newcomer = p.m_radParticles[p.m_radParticles.length - 1].slot;
    settle(l);

    // The newcomer took the BURNT-OUT slot, and every patch that was still glowing still has its
    // earth. Asserted on the terrain, not on the zone list: recycling a slot wipes the pixels but
    // leaves the old zone in place, so "its zone is still listed" would pass either way.
    expect(newcomer).toBe(doomed);
    const hot = hotBySlot(l);
    for (const s of kept) expect(hot.get(s) ?? 0).toBeGreaterThan(0);
  });

  it('with every slot still burning, it recycles the FAINTEST rather than the oldest', () => {
    const l = land();
    const p = landPriv(l);

    // Eight live events, all still glowing. Seven get an effectively endless clock; the fourth gets
    // a short one, so after a while it is the FAINTEST while the first is still the OLDEST CLAIM and
    // burning at full brightness. Those name different slots, which is the whole question:
    // recycling by age would erase the brightest coat on the map.
    const slots: number[] = [];
    for (let i = 0; i < 8; i++) {
      l.beginRadiationEvent();
      const hue: [number, number, number] = [40 + i * 20, 255 - i * 10, 60];
      l.blastIradiate(60 + i * 80, SURFACE, 30, 5, i === 3 ? 10 : 1000, hue);
      slots.push(p.m_radParticles[p.m_radParticles.length - 1].slot);
      settle(l);
    }
    for (let i = 0; i < 60 * 25; i++) l.update(1 / 60); // the short clock runs most of the way down
    const fadeOf = (s: number): number => {
      const z = p.m_radParticles.find(q => q.slot === s)!;
      return z.timeRemaining / z.duration;
    };
    expect(p.m_radParticles.length).toBe(8); // all still burning
    const faintest = slots.reduce((a, b) => (fadeOf(b) < fadeOf(a) ? b : a));
    expect(faintest).toBe(slots[3]);
    expect(fadeOf(slots[0])).toBeGreaterThan(fadeOf(faintest) * 5); // oldest ≠ faintest, by a mile

    l.beginRadiationEvent();
    l.blastIradiate(400, SURFACE, 30, 5, 900, [10, 20, 200]);
    expect(p.m_radParticles[p.m_radParticles.length - 1].slot).toBe(faintest);
  });
});
