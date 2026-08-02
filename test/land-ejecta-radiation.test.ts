/**
 * Contaminated spoil.
 *
 * Radiation used to accumulate as its OWN particle cloud, laid down independently of the dirt: the
 * ejecta deposited clean soil and a separate fallout cloud dusted a film over whatever the surface
 * ended up being. So the two disagreed about where the hot material was — the rim, where grains
 * drifted and no dirt landed, ended up hotter than the metres of spoil piled in the middle of the
 * bowl, which read as inert brown with a red skin.
 *
 * The earth a radioactive blast throws IS the contaminated material, so it lands hot through its
 * whole thickness, and the glow is drawn down the contiguous hot body rather than to a fixed depth.
 * Radiation therefore accumulates exactly where — and as deeply as — the dirt does.
 */
import {describe, it, expect} from 'vitest';

import {CLand} from '../src/core/CLand';
import {CShot} from '../src/core/CShot';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE, getWeapon, weaponName} from '../src/core/CWeapon';
import {Vec2} from '../src/math/Vec2';
import {weaponDetonate, type ShotWorld} from '../src/core/weapons/WeaponBehavior';

const W = 1400;
const H = 700;
const SURFACE = 260;
const CX = W / 2;

function idxOf(name: string): number {
  const i = WEAPON_DATABASE.findIndex(w => weaponName(w) === name);
  if (i < 0) throw new Error(`weapon not found: ${name}`);
  return i;
}

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

/** Depth (px) of the contiguous run of radioactive earth under a column's surface — what the glow
 *  now lights, and what "how much of this dirt is hot" means. */
function hotDepth(land: CLand, col: number): number {
  const p = land as unknown as {m_material: Uint8Array; m_arrHeights: Int16Array};
  const top = p.m_arrHeights[col];
  let d = 0;
  while (top + d < H && ((p.m_material[(top + d) * W + col] >>> 1) & 31) > 0) d++;
  return d;
}

function fire(name: string): CLand {
  GameConfig.explosionScale = 1;
  const land = flatLandPx();
  const w = getWeapon(idxOf(name));
  const shot = new CShot();
  shot.initFromVelocity(new Vec2(CX, SURFACE), 0, 120, w.getDamage(), w.getRadius(), null);
  shot.setWeaponIndex(w.getIndex());
  weaponDetonate(shot, w, world(land));
  for (let i = 0; i < 60 * 12; i++) land.update(1 / 60);
  return land;
}

/** Mean hot depth over a band of columns at `[from, to]` px either side of ground zero. */
function meanHot(land: CLand, from: number, to: number): number {
  let sum = 0,
    n = 0;
  for (let d = from; d <= to; d++) {
    for (const col of [CX - d, CX + d]) {
      sum += hotDepth(land, col);
      n++;
    }
  }
  return sum / n;
}

describe('Contaminated spoil', () => {
  it("a nuke's fill is hot through its DEPTH, not a surface film", () => {
    const land = fire('Uranium Nuke'); // radius 140, fodder 0.3 → a deep bowl of its own spoil
    // The middle of the bowl is where the spoil piles deepest. A film would be 1–2px there.
    expect(meanHot(land, 0, 40)).toBeGreaterThan(8);
  });

  it('radiation accumulates where the DIRT does — not heaped at the crater rim', () => {
    const land = fire('Uranium Nuke');
    const middle = meanHot(land, 0, 40); // over the accumulated fill
    const rim = meanHot(land, 115, 138); // the crater's outer edge, where little spoil lands
    expect(middle).toBeGreaterThan(rim);
  });

  it('a clean weapon deposits CLEAN fill — spoil is only hot if the blast was', () => {
    const land = fire('Bomb'); // no irTime/irDmg
    expect(meanHot(land, 0, 40)).toBe(0);
  });

  it('fallout stays inside the crater the blast dug', () => {
    const land = fire('Uranium Nuke');
    // Well beyond the 140px bowl: undisturbed ground must not glow.
    expect(meanHot(land, 170, 260)).toBe(0);
  });
});
