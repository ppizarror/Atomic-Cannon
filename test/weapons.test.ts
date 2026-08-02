/**
 * Deterministic logic tests for the weapon-behaviour system.
 */
import {describe, it, expect} from 'vitest';

import {CLand} from '../src/core/CLand';
import {CShot} from '../src/core/CShot';
import {WEAPON_DATABASE, getWeapon, weaponName} from '../src/core/CWeapon';
import {Vec2} from '../src/math/Vec2';
import {
  weaponFlyStep,
  weaponDetonate,
  spawnCluster,
  firedIntoTerrain,
  type ShotWorld,
} from '../src/core/weapons/WeaponBehavior';

function idxOf(name: string): number {
  const i = WEAPON_DATABASE.findIndex(w => weaponName(w) === name);
  if (i < 0) throw new Error(`weapon not found: ${name}`);
  return i;
}

// Flat terrain: surface at y=300 across an 800-wide field.
function flatLand(surface = 300): CLand {
  const land = new CLand(800, 400);
  const h = new Int16Array(800);
  h.fill(surface);
  land.initFromArray(h, 1, 1);
  return land;
}

// Flat terrain WITH a real pixel buffer (solid ground below `surface`, sky above). The
// pixel-level carve/collapse ops (sliceColumn / falling blocks) only run when `m_pixels`
// exists — the headless DOM mock no-ops getImageData — so digger tests that need the true
// game geometry (overburden slides down; no floating dirt) must install a buffer.
function flatLandPx(surface = 200): CLand {
  const W = 800,
    H = 400;
  const land = new CLand(W, H);
  land.generateFlat();
  const p = land as unknown as {
    m_pixels: Uint32Array;
    m_material: Uint8Array;
    m_arrHeights: Int16Array;
  };
  const px = new Uint32Array(W * H);
  const mat = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    p.m_arrHeights[x] = surface;
    for (let y = surface; y < H; y++) px[y * W + x] = 0xff3c5a1e >>> 0; // opaque solid ground
  }
  p.m_pixels = px;
  p.m_material = mat;
  return land;
}

/** Count solid pixels stranded strictly ABOVE each column's surface height (= floating dirt). */
function floatingPixels(land: CLand): number {
  const p = land as unknown as {m_pixels: Uint32Array; m_arrHeights: Int16Array; m_nWidth: number};
  let n = 0;
  for (let x = 0; x < p.m_nWidth; x++) {
    for (let y = 0; y < p.m_arrHeights[x]; y++) {
      if ((p.m_pixels[y * p.m_nWidth + x] & 0xff000000) !== 0) n++;
    }
  }
  return n;
}

class MockWorld implements ShotWorld {
  land: CLand;
  tanks: any[] = [];
  spawned: CShot[] = [];
  mines = 0;
  sentries = 0;
  markers = 0;
  blasts: number[] = [];
  blastScale = 1; // resolution-based blast scale (derived render value on the world context)

  random(): number {
    return Math.random();
  }

  constructor(land: CLand) {
    this.land = land;
  }

  spawnShot(s: CShot) {
    this.spawned.push(s);
  }

  explode() {}

  shake() {}

  ripple() {}
  debrisSpray() {}

  applyBlast(_p: Vec2, _r: number, dmg: number) {
    this.blasts.push(dmg);
  }

  aimMarker() {
    this.markers++;
  }

  deployMine() {
    this.mines++;
  }

  deploySentry() {
    this.sentries++;
  }

  hitSound() {}
}

describe('Weapon behaviour', () => {
  it('a Cleaner (Earth Destroy) REMOVES terrain across its radius when it detonates at the surface', () => {
    const surface = 300;
    const land = flatLand(surface);
    const w = getWeapon(idxOf('Earth Destroy'));
    expect(w.isCleaner()).toBe(true);
    const world = new MockWorld(land);
    const shot = new CShot();
    // Impact right at the surface (a landed shot).
    shot.initFromVelocity(new Vec2(400, surface), 0, 120, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());

    weaponDetonate(shot, w, world);

    // A cleaner must LOWER the surface (screen-Y down: a carved column has a LARGER height number)
    // across a wide swath — this is the whole point of an earth-remover.
    expect(land.getHeightAt(400)).toBeGreaterThan(surface); // centre carved down
    let carved = 0;
    for (let x = 340; x <= 460; x++) if (land.getHeightAt(x) > surface) carved++;
    expect(carved).toBeGreaterThan(60); // a wide swath removed, not just a nick
  });

  it('a Cleaner detonating a bit ABOVE the surface still cleans the GROUND (not empty air)', () => {
    // Regression: the cleaner used to carve at `pos.y`; when the blast resolved above the ground it
    // carved empty sky and removed NOTHING (the "blast floats, terrain intact" bug). It must carve
    // the surface under the impact instead.
    const surface = 300;
    const land = flatLand(surface);
    const w = getWeapon(idxOf('Earth Destroy'));
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, surface - 40), 0, 60, w.getDamage(), w.getRadius(), null); // 40px ABOVE ground
    shot.setWeaponIndex(w.getIndex());

    weaponDetonate(shot, w, world);

    expect(land.getHeightAt(400)).toBeGreaterThan(surface); // ground under the impact is cleaned
  });

  it('a Cleaner still cleans with a FRACTIONAL blast scale (regression: no-op crater)', () => {
    // The real bug: `blastScale` (Explosion Size × resolution) is often NON-integer, so radiusPx =
    // radius × scale is fractional (130×1.47≈191). The carve then iterated fractional column indices
    // and carved NOTHING — the cleaner showed only fumes, no crater. Guard the end-to-end path.
    const surface = 300;
    const land = flatLand(surface);
    const w = getWeapon(idxOf('Earth Destroy'));
    const world = new MockWorld(land);
    world.blastScale = 1.47; // makes radiusPx fractional
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, surface), 0, 120, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());

    weaponDetonate(shot, w, world);

    expect(land.getHeightAt(400)).toBeGreaterThan(surface); // it cleans despite the fractional radius
  });

  it('Airburst detonates at apex (mid-air, before hitting ground)', () => {
    const land = flatLand(300);
    const w = getWeapon(idxOf('Shrapnel')); // Airburst, extType 13
    const world = new MockWorld(land);
    const shot = new CShot();
    // Launch upward from y=280 (above surface): vy negative → rising.
    shot.initFromVelocity(new Vec2(400, 280), 40, -300, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    let action = 'continue',
      steps = 0,
      apexY = 999;
    while (action === 'continue' && steps++ < 2000) {
      shot.update(1 / 60, new Vec2(0, 0));
      apexY = Math.min(apexY, shot.getPosition().y);
      action = weaponFlyStep(shot, w, world, 1 / 60);
    }
    const y = shot.getPosition().y;
    expect(action === 'detonate' && y < 300).toBe(true); // Airburst detonates at apex, above ground
    expect(Math.abs(y - apexY) < 20).toBe(true); // Airburst apex is the highest point reached
  });

  it('Cluster: cluNum children at gen+1 and 0.5x power', () => {
    const land = flatLand(300);
    const w = getWeapon(idxOf('Hex Bomb')); // cluNum 6, full-circle
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    shot.setPower(100);
    spawnCluster(shot, w, world, new Vec2(400, 300));
    expect(world.spawned).toHaveLength(6); // Cluster spawns cluNum children
    expect(world.spawned.every(s => s.getGeneration() === 1)).toBe(true); // Children are generation 1
    expect(world.spawned.every(s => s.getPower() === 50)).toBe(true); // Children launch at 0.5x power
    // Full-circle: children fan in many directions (both up and down present).
    const vys = world.spawned.map(s => s.getVelocity().y);
    expect(vys.some(v => v < -1) && vys.some(v => v > 1)).toBe(true); // Full-circle fan sends some up and some down
  });

  it('Cluster recursion depth honours cluRecurse', () => {
    const w = getWeapon(idxOf('Hex Bomb')); // cluRecurse 1
    const world = new MockWorld(flatLand());
    const gen1 = new CShot();
    gen1.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    gen1.setGeneration(1); // already a submunition
    spawnCluster(gen1, w, world, new Vec2(400, 300));
    expect(world.spawned).toHaveLength(0); // Cluster stops recursing past cluRecurse
  });

  it('Cluster power is a FLAT 0.5× the firing power at every recursion depth (not compounding)', () => {
    const w = getWeapon(WEAPON_DATABASE.findIndex(x => x.id === 'sabot')); // cluRecurse 8, cluNum 1
    const world = new MockWorld(flatLand());
    const g0 = new CShot();
    g0.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    g0.setWeaponIndex(w.getIndex());
    g0.setPower(200); // the firing power
    spawnCluster(g0, w, world, new Vec2(400, 300));
    const g1 = world.spawned[0];
    expect(g1.getPower()).toBeCloseTo(100); // 0.5 × 200

    // A gen-1 submunition re-clusters: its child must ALSO be 0.5×200 = 100, NOT the old
    // 0.5×100 = 50 (which compounded to 0.5ⁿ and made deep drillers barely move).
    world.spawned = [];
    spawnCluster(g1, w, world, new Vec2(400, 300));
    expect(world.spawned[0].getGeneration()).toBe(2);
    expect(world.spawned[0].getPower()).toBeCloseTo(100); // flat, not 50
  });

  it('Rebound jets out on burial, then drops anti-grav on emergence to arc back down', () => {
    const land = flatLand(300);
    const w = getWeapon(WEAPON_DATABASE.findIndex(x => x.extType === 9)); // Rebounder/Seeker
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 310), 0, 50, w.getDamage(), w.getRadius(), null); // just buried
    shot.setWeaponIndex(w.getIndex());

    weaponFlyStep(shot, w, world, 1 / 60);
    expect(shot.isAntiGrav()).toBe(true); // latches while below the surface → jets up and out

    shot.setPosition(400, 250); // now well ABOVE the surface (300)
    weaponFlyStep(shot, w, world, 1 / 60);
    expect(shot.isAntiGrav()).toBe(false); // emerged → anti-grav cleared so gravity arcs it back down
    expect(shot.hasRebounded()).toBe(true); // and it won't jet up again — next impact detonates
  });

  it('Dirt deposits earth (raises, removes nothing)', () => {
    const land = flatLand(300);
    const w = getWeapon(idxOf('Dirty Boy')); // earth 50
    const world = new MockWorld(land);
    const cx = 400;
    const before: number[] = [];
    for (let x = cx - 80; x <= cx + 80; x++) before.push(land.getHeightAt(x));
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(cx, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    weaponDetonate(shot, w, world);
    // Dirt is a thrown earth cloud that arcs up and rains back down — settle it.
    for (let f = 0; f < 400; f++) land.update(1 / 60);
    // It RAISED the surface at the impact (smaller screen-Y)…
    expect(land.getHeightAt(cx) < before[80]).toBe(true); // Dirt raises terrain at impact
    // …and REMOVED nothing — no column ended up lower (larger Y) than it started.
    let dug = 0;
    for (let i = 0; i < before.length; i++) {
      if (land.getHeightAt(cx - 80 + i) > before[i] + 1) dug++;
    }
    expect(dug).toBe(0); // Dirt removes no terrain
  });

  // Fly a digger from just above the surface at a shallow downward angle, so it enters the mass
  // and bores a long diagonal channel before reaching its dig depth. Returns the settled land.
  function flyDigger(detonate: boolean): {land: CLand; detX: number} {
    const land = flatLandPx(200);
    const w = getWeapon(WEAPON_DATABASE.findIndex(x => x.id === 'digger')); // extType DIGGER
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(120, 190), 320, 60, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    let action = 'continue',
      steps = 0;
    while (action === 'continue' && steps++ < 5000) {
      shot.update(1 / 60, new Vec2(0, 0));
      action = weaponFlyStep(shot, w, world, 1 / 60);
    }
    expect(action).toBe('detonate');
    const detX = shot.getPosition().x;
    if (detonate) weaponDetonate(shot, w, world);
    for (let f = 0; f < 600; f++) land.update(1 / 60); // settle all falling overburden
    return {land, detX};
  }

  it('Digger bores a continuous, shallow, backfilling channel (not a deep wide cave-to-shell)', () => {
    const {land, detX} = flyDigger(false); // flight only — isolate the bore from the end crater
    const dropAt = (x: number) => land.getHeightAt(Math.round(x)) - 200; // larger Y = lower surface

    // Dug DURING flight, all along the path — a single end-crater could not touch early/mid columns.
    expect(dropAt(detX - 120)).toBeGreaterThan(3); // near the entry…
    expect(dropAt(detX - 70)).toBeGreaterThan(3); // …the middle…
    expect(dropAt(detX - 25)).toBeGreaterThan(3); // …and the end: a continuous channel.
    // The tunnel BACKFILLS: the surface only dents by ~the bore height (size 10 → ~2·10), it does
    // NOT cave down toward the buried shell. Every sampled column stays a shallow dent.
    for (const x of [detX - 120, detX - 70, detX - 25]) {
      expect(dropAt(x)).toBeLessThan(40); // ≪ the ~100px depth a cave-to-shell would show
    }
  });

  it('Digger leaves NO floating dirt after it detonates', () => {
    const {land} = flyDigger(true); // full bore + buried detonation crater
    expect(floatingPixels(land)).toBe(0); // no solid pixels stranded in the sky above the surface
  });

  it('NUKE creates a radiation zone', () => {
    const land = flatLand(300);
    const w = getWeapon(idxOf('Uranium Nuke'));
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    weaponDetonate(shot, w, world);
    expect(land.getRadiationZones()).toHaveLength(1); // NUKE creates a radiation zone
  });

  it('Roller converts to a horizontal surface roll', () => {
    // Slope down to the right: surface Y grows with x → roller should go left (uphill lower? no: lower = larger Y = right).
    const land = new CLand(800, 400);
    const h = new Int16Array(800);
    for (let x = 0; x < 800; x++) h[x] = 250 + Math.floor(x * 0.1); // right side is lower (larger Y)
    land.initFromArray(h, 1, 1);
    const w = getWeapon(idxOf('Roller')); // extType 2
    const world = new MockWorld(land);
    const shot = new CShot();
    const sx = 400,
      sy = land.getHeightAt(400);
    shot.initFromVelocity(new Vec2(sx, sy - 1), 50, 50, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    shot.update(1 / 60, new Vec2(0, 0));
    const action = weaponFlyStep(shot, w, world, 1 / 60);
    const vx = shot.getVelocity().x;
    expect(Math.abs(shot.getVelocity().y) < 1 && action === 'continue').toBe(true); // Roller rolls horizontally (vy≈0)
    expect(vx).toBeGreaterThan(0); // Roller heads downhill to the right
  });

  it('Beam damages full (no falloff) & no crater', () => {
    const land = flatLand(300);
    const w = getWeapon(WEAPON_DATABASE.findIndex(x => x.extType === 5)); // a Beam
    const world = new MockWorld(land);
    const before = land.getHeightAt(400);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    weaponDetonate(shot, w, world);
    expect(land.getHeightAt(400)).toBe(before); // Beam leaves no crater
  });

  describe('a shot fired from inside terrain (buried tank)', () => {
    const surface = 300;
    const BALLISTIC = getWeapon(WEAPON_DATABASE.findIndex(x => (x.extType ?? 0) === 0));
    const DIGGER = getWeapon(WEAPON_DATABASE.findIndex(x => x.extType === 1));
    // Minimal owner stand-in — firedIntoTerrain only reads isBuried().
    const owner = (buried: boolean) => ({isBuried: () => buried}) as any;
    // Spawn a shot at muzzle-Y `my` with the given weapon and owner.
    const muzzleShot = (w: ReturnType<typeof getWeapon>, my: number, buried: boolean): CShot => {
      const shot = new CShot();
      shot.initFromVelocity(
        new Vec2(400, my),
        300,
        -300,
        w.getDamage(),
        w.getRadius(),
        owner(buried),
      );
      shot.setWeaponIndex(w.getIndex());
      return shot;
    };

    it('detonates a ballistic shot at the muzzle when the firer is buried and the muzzle is in dirt', () => {
      const world = new MockWorld(flatLand(surface));
      const shot = muzzleShot(BALLISTIC, surface + 10, true); // muzzle 10px below surface
      expect(firedIntoTerrain(shot, BALLISTIC, world)).toBe(true);
    });

    it('does NOT detonate a normal (un-buried) tank firing steeply downward, even if the muzzle dips underground', () => {
      const world = new MockWorld(flatLand(surface));
      const shot = muzzleShot(BALLISTIC, surface + 10, false); // same muzzle depth, firer not buried
      expect(firedIntoTerrain(shot, BALLISTIC, world)).toBe(false);
    });

    it('does NOT detonate a buried firer whose muzzle pokes ABOVE the surface (barrel cleared the dirt)', () => {
      const world = new MockWorld(flatLand(surface));
      const shot = muzzleShot(BALLISTIC, surface - 20, true); // muzzle 20px above surface
      expect(firedIntoTerrain(shot, BALLISTIC, world)).toBe(false);
    });

    it('exempts a Digger fired while buried — it tunnels, it does not detonate at the muzzle', () => {
      const world = new MockWorld(flatLand(surface));
      const shot = muzzleShot(DIGGER, surface + 10, true);
      expect(firedIntoTerrain(shot, DIGGER, world)).toBe(false);
    });
  });
});
