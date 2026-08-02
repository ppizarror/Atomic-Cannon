/**
 * Crater geometry + spoil budget.
 *
 * Two properties the nuke tier used to break:
 *
 *  1. **Crater radius is `weapon.radius × explosionScale`, for every weapon.** The original stamps a
 *     burst mask of exactly that pixel radius (`FUN_004a6480`, `combat_physics.md` §3) and its crater
 *     path has no nuke branch — a nuke digs a big hole only because its authored `radius` is big. The
 *     port used to widen nuke bowls a further 1.35×.
 *
 *  2. **A blast throws back the same FRACTION of its own crater whatever its size.** The ejecta count
 *     used to grow linearly with radius while the bowl grows with its square, so the refilled share
 *     fell off as ~1/r: a bomb put back a third of its crater, Uranium a fifth, Isotope a tenth —
 *     big weapons left a bare pit. Both weapons below must now refill to within a factor of ~1.5.
 */
import {describe, it, expect} from 'vitest';

import {CLand} from '../src/core/CLand';
import {CShot} from '../src/core/CShot';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE, getWeapon, weaponName, type CWeapon} from '../src/core/CWeapon';
import {Vec2} from '../src/math/Vec2';
import {weaponDetonate, type ShotWorld} from '../src/core/weapons/WeaponBehavior';

const W = 1400;
const H = 700;
const SURFACE = 260;

function idxOf(name: string): number {
  const i = WEAPON_DATABASE.findIndex(w => weaponName(w) === name);
  if (i < 0) throw new Error(`weapon not found: ${name}`);
  return i;
}

/** Flat ground with a real pixel buffer — the carve/collapse path only runs when `m_pixels` exists. */
function flatLandPx(): CLand {
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as {
    m_pixels: Uint32Array;
    m_material: Uint8Array;
    m_arrHeights: Int16Array;
  };
  const px = new Uint32Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = SURFACE;
    for (let y = SURFACE; y < H; y++) px[y * W + x] = 0xff3c5a1e >>> 0;
  }
  p.m_pixels = px;
  p.m_material = new Uint8Array(W * H);
  return land;
}

const world = (land: CLand): ShotWorld =>
  ({
    land,
    tanks: [],
    blastScale: 1,
    random: () => Math.random(),
    spawnShot: () => {},
    explode: () => {},
    shake: () => {},
    ripple: () => {},
    applyBlast: () => {},
    aimMarker: () => {},
    deployMine: () => {},
    deploySentry: () => {},
    hitSound: () => {},
  }) as unknown as ShotWorld;

/** Earth missing from the field, in px-columns (positive = a hole, negative = a pile). */
function deficit(land: CLand): number {
  let v = 0;
  for (let x = 0; x < W; x++) v += land.getHeightAt(x) - SURFACE;
  return v;
}

function detonateAt(land: CLand, w: CWeapon, x: number): void {
  const shot = new CShot();
  shot.initFromVelocity(new Vec2(x, SURFACE), 0, 120, w.getDamage(), w.getRadius(), null);
  shot.setWeaponIndex(w.getIndex());
  weaponDetonate(shot, w, world(land));
}

/** Detonate, then run the land until every chunk has landed. Returns dug/refilled volume. */
function crater(name: string): {dug: number; back: number; radius: number} {
  GameConfig.explosionScale = 1;
  const land = flatLandPx();
  const w = getWeapon(idxOf(name));
  detonateAt(land, w, W / 2);
  const dug = deficit(land);
  // Widest column the carve reached (the crater's own radius, before any spoil comes back).
  let radius = 0;
  for (let x = 0; x < W; x++) {
    if (land.getHeightAt(x) > SURFACE) radius = Math.max(radius, Math.abs(x - W / 2));
  }
  for (let i = 0; i < 60 * 12; i++) land.update(1 / 60);
  return {dug, back: dug - deficit(land), radius};
}

describe('Crater geometry and spoil budget', () => {
  it('a nuke carves `radius × explosionScale` — no wider than any other weapon', () => {
    // Uranium Nuke: authored radius 140, blastScale 1, explosionScale 1 → a 140px bowl. The old
    // 1.35× nuke bonus put this at ~189.
    const {radius} = crater('Uranium Nuke');
    expect(radius).toBeGreaterThan(130);
    expect(radius).toBeLessThanOrEqual(142); // +ragged-rim slack, nowhere near 189
  });

  it('a nuke refills the same share of its crater as a plain bomb', () => {
    const bomb = crater('Bomb'); // radius 50, fodder 0.1
    const nuke = crater('Uranium Nuke'); // radius 140, fodder 0.3

    expect(nuke.dug).toBeGreaterThan(bomb.dug * 5); // it really does dig a far bigger hole
    const bombShare = bomb.back / bomb.dug;
    const nukeShare = nuke.back / nuke.dug;
    expect(bombShare).toBeGreaterThan(0.15);
    expect(nukeShare).toBeGreaterThan(0.15);
    // The whole point: the ratio no longer collapses with size (it was ~3× worse for the nuke).
    expect(nukeShare).toBeGreaterThan(bombShare * 0.66);
  });
});
