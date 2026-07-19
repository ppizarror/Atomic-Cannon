/**
 * Deterministic logic tests for the weapon-behaviour system (Phase 3).
 * Run: pnpm tsx scripts/test-weapons.ts
 */
import {CLand} from '../src/core/CLand';
import {CShot} from '../src/core/CShot';
import {CWeapon, WEAPON_DATABASE, getWeapon} from '../src/core/CWeapon';
import {Vec2} from '../src/math/Vec2';
import {weaponFlyStep, weaponDetonate, spawnCluster, type ShotWorld} from '../src/core/weapons/WeaponBehavior';

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, extra = '') {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.log(`  ✗ ${name}  ${extra}`);
    }
}

function idxOf(name: string): number {
    const i = WEAPON_DATABASE.findIndex(w => w.name === name);
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

class MockWorld implements ShotWorld {
    land: CLand;
    tanks: any[] = [];
    spawned: CShot[] = [];
    mines = 0;
    sentries = 0;
    markers = 0;
    blasts: number[] = [];

    constructor(land: CLand) {
        this.land = land;
    }

    spawnShot(s: CShot) {
        this.spawned.push(s);
    }

    explode() {
    }

    shake() {
    }

    ripple() {
    }

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

    hitSound() {
    }
}

// ---- 1. Airburst detonates at apex (mid-air, before hitting ground) ----------
{
    const land = flatLand(300);
    const w = getWeapon(idxOf('Shrapnel'));   // Airburst, extType 13
    const world = new MockWorld(land);
    const shot = new CShot();
    // Launch upward from y=280 (above surface): vy negative → rising.
    shot.initFromVelocity(new Vec2(400, 280), 40, -300, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    let action = 'continue', steps = 0, apexY = 999;
    while (action === 'continue' && steps++ < 2000) {
        shot.update(1 / 60, new Vec2(0, 0));
        apexY = Math.min(apexY, shot.getPosition().y);
        action = weaponFlyStep(shot, w, world, 1 / 60);
    }
    const y = shot.getPosition().y;
    ok('Airburst detonates at apex, above ground', action === 'detonate' && y < 300, `action=${action} y=${y.toFixed(0)}`);
    ok('Airburst apex is the highest point reached', Math.abs(y - apexY) < 20, `y=${y.toFixed(0)} apex=${apexY.toFixed(0)}`);
}

// ---- 2. Cluster: cluNum children at gen+1 and 0.5x power ----------------------
{
    const land = flatLand(300);
    const w = getWeapon(idxOf('Hex Bomb'));    // cluNum 6, full-circle
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    shot.setPower(100);
    spawnCluster(shot, w, world, new Vec2(400, 300));
    ok('Cluster spawns cluNum children', world.spawned.length === 6, `got ${world.spawned.length}`);
    ok('Children are generation 1', world.spawned.every(s => s.getGeneration() === 1));
    ok('Children launch at 0.5x power', world.spawned.every(s => s.getPower() === 50), `pow=${world.spawned[0]?.getPower()}`);
    // Full-circle: children fan in many directions (both up and down present).
    const vys = world.spawned.map(s => s.getVelocity().y);
    ok('Full-circle fan sends some up and some down', vys.some(v => v < -1) && vys.some(v => v > 1));
}

// ---- 3. Cluster recursion depth honours cluRecurse ---------------------------
{
    const w = getWeapon(idxOf('Hex Bomb'));   // cluRecurse 1
    const world = new MockWorld(flatLand());
    const gen1 = new CShot();
    gen1.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    gen1.setGeneration(1);                     // already a submunition
    spawnCluster(gen1, w, world, new Vec2(400, 300));
    ok('Cluster stops recursing past cluRecurse', world.spawned.length === 0, `got ${world.spawned.length}`);
}

// ---- 4. Dirt raises terrain (surface Y decreases) ----------------------------
{
    const land = flatLand(300);
    const w = getWeapon(idxOf('Dirty Boy'));   // earth 50
    const world = new MockWorld(land);
    const before = land.getHeightAt(400);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    weaponDetonate(shot, w, world);
    const after = land.getHeightAt(400);
    ok('Dirt raises terrain (smaller surface Y)', after < before, `before=${before} after=${after}`);
}

// ---- 5. NUKE creates a radiation zone ----------------------------------------
{
    const land = flatLand(300);
    const w = getWeapon(idxOf('Uranium Nuke'));
    const world = new MockWorld(land);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    weaponDetonate(shot, w, world);
    ok('NUKE creates a radiation zone', land.getRadiationZones().length === 1, `zones=${land.getRadiationZones().length}`);
}

// ---- 6. Roller converts to a horizontal surface roll -------------------------
{
    // Slope down to the right: surface Y grows with x → roller should go left (uphill lower? no: lower = larger Y = right).
    const land = new CLand(800, 400);
    const h = new Int16Array(800);
    for (let x = 0; x < 800; x++) h[x] = 250 + Math.floor(x * 0.1);  // right side is lower (larger Y)
    land.initFromArray(h, 1, 1);
    const w = getWeapon(idxOf('Roller'));       // extType 2
    const world = new MockWorld(land);
    const shot = new CShot();
    const sx = 400, sy = land.getHeightAt(400);
    shot.initFromVelocity(new Vec2(sx, sy - 1), 50, 50, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    shot.update(1 / 60, new Vec2(0, 0));
    const action = weaponFlyStep(shot, w, world, 1 / 60);
    const vx = shot.getVelocity().x;
    ok('Roller rolls horizontally (vy≈0)', Math.abs(shot.getVelocity().y) < 1 && action === 'continue', `action=${action}`);
    ok('Roller heads downhill to the right', vx > 0, `vx=${vx}`);
}

// ---- 7. Beam damages full (no falloff) & no crater ---------------------------
{
    const land = flatLand(300);
    const w = getWeapon(WEAPON_DATABASE.findIndex(x => x.extType === 5));  // a Beam
    const world = new MockWorld(land);
    const before = land.getHeightAt(400);
    const shot = new CShot();
    shot.initFromVelocity(new Vec2(400, 300), 0, 0, w.getDamage(), w.getRadius(), null);
    shot.setWeaponIndex(w.getIndex());
    weaponDetonate(shot, w, world);
    ok('Beam leaves no crater', land.getHeightAt(400) === before, `before=${before} after=${land.getHeightAt(400)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
