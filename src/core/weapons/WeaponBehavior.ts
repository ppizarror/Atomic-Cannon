/**
 * Weapon behaviours — one dispatcher over `extType`, the weapon's behaviour selector.
 *
 * Covers per-frame shot dispatch and the detonation path. The mechanics (which
 * extType does what, cluster fan, battery drop, roller/digger motion, radiation
 * fields) are documented in the notes; a couple of pieces (radiation
 * damage-over-time, the `earth` deposit amount) are derived from the data fields.
 */
import {Vec2} from '../../math/Vec2';
import {CShot} from '../CShot';
import {CTank} from '../CTank';
import {CLand} from '../CLand';
import {CWeapon} from '../CWeapon';
import {GameConfig} from '../CGameConfig';

/** extType values. 0 and unlisted = plain ballistic. */
export const EXT = {
    BALLISTIC: 0, DIGGER: 1, ROLLER: 2, TRACER: 4, BEAM: 5, BEAM2: 6,
    ESCAPE: 8, REBOUND: 9, DEATH: 12, AIRBURST: 13, MINE: 16, JET: 17, SENTRY: 18,
} as const;

// Shot speed per unit power — same scaling the launch path uses.
const SPEED_SCALE = 0.9;
// Submunition launch power = 0.5x firing power.
const CLUSTER_POWER = 0.5;
// Roller surface speed (px/s in our space).
const ROLL_SPEED = 260;
// Max shot lifetime before it self-detonates (10.0s).
const MAX_LIFE = 10;

/** The world a shot behaves against — implemented by the game controller. */
export interface ShotWorld {
    readonly land: CLand;
    readonly tanks: CTank[];

    spawnShot(shot: CShot): void;

    /** Detonation FX. `color`/`radiusPx`/`nuclear` tint & scale the burst; `blastPreset`
     * names its particles.json effect; `expType` (0–4) + `expBitmap` select the weapon's
     * own explosion flare sprite and style. */
    explode(x: number, y: number, scale: number, color?: string, radiusPx?: number, nuclear?: boolean, blastPreset?: string, expType?: number, expBitmap?: string): void;

    shake(mag: number, dur: number): void;

    ripple(x: number, y: number, strength: number): void;

    /** Falloff blast damage + kick + shield/armor. `full` skips falloff (beams). */
    applyBlast(pos: Vec2, radius: number, damage: number, owner: CTank | null, full: boolean): void;

    aimMarker(x: number, y: number): void;

    deployMine(x: number, y: number, owner: CTank | null, weaponIndex: number): void;

    deploySentry(x: number, y: number, owner: CTank | null, weaponIndex: number): void;

    /** Play a weapon's impact sound (`soundHit`) panned to the blast, if audio is wired. */
    hitSound(name: string, x: number): void;
}

export type FlyAction = 'continue' | 'detonate' | 'consumed';

function tankHit(shot: CShot, world: ShotWorld): CTank | null {
    const p = shot.getPosition();
    for (const t of world.tanks) {
        if (t.isAlive() && t.distanceTo(p.x, p.y) < t.getHitRadius()) return t;
    }
    return null;
}

/**
 * Per-frame decision for a shot in flight, dispatched on extType. Runs AFTER the
 * shot's integrator step. Returns whether the shot keeps flying, detonates, or
 * was consumed (deployed / left the world) with no explosion.
 */
export function weaponFlyStep(shot: CShot, weapon: CWeapon, world: ShotWorld, dt: number): FlyAction {
    const land = world.land;
    const p = shot.getPosition();

    // Left the world entirely.
    if (p.x < -60 || p.x > land.width + 60 || p.y > land.height + 80) return 'consumed';

    const ext = weapon.getExtType();
    const isBeam = ext === EXT.BEAM || ext === EXT.BEAM2;

    // Battery: primary shots drop a bomblet straight down every batSec while descending.
    if (!isBeam) batteryTick(shot, weapon, world, dt);

    const surfaceY = land.getHeightAt(Math.floor(p.x));
    const belowSurface = p.y >= surfaceY - 4;
    const hit = tankHit(shot, world);

    // Lifetime cap (rebound/roller can loop) — detonate rather than fly forever.
    if (shot.getAge() > MAX_LIFE) return 'detonate';

    switch (ext) {
        case EXT.BEAM:
        case EXT.BEAM2:
            // Hitscan: straight line (no gravity, set at launch). Detonates on a tank.
            return hit ? 'detonate' : 'continue';

        case EXT.AIRBURST:
            // Detonate at the apex (once it starts descending), or on early contact.
            if (hit || belowSurface) return 'detonate';
            return shot.isMovingDown() ? 'detonate' : 'continue';

        case EXT.DIGGER:
            // Burrow straight down carving craters until a depth limit, then detonate.
            if (hit) return 'detonate';
            if (belowSurface && shot.isMovingDown()) {
                if (p.y < surfaceY + DIG_DEPTH) {
                    land.blastCircle(Math.floor(p.x), Math.floor(p.y), diggerBore(shot));
                    return 'continue';
                }
                return 'detonate';
            }
            return 'continue';

        case EXT.ESCAPE:
            // Mirror of Digger: tunnel UP while rising; detonate once it starts falling.
            if (hit) return 'detonate';
            if (belowSurface) {
                if (!shot.isMovingDown()) {
                    land.blastCircle(Math.floor(p.x), Math.floor(p.y), diggerBore(shot));
                    return 'continue';
                }
                return 'detonate';
            }
            return 'continue';

        case EXT.ROLLER:
            return rollerStep(shot, world, surfaceY, hit);

        case EXT.REBOUND:
            // Anti-grav on ground contact: gravity inverts while submerged → it bounces.
            if (hit) return 'detonate';
            shot.setAntiGrav(belowSurface);
            return 'continue';

        case EXT.MINE:
            if (belowSurface) {
                world.deployMine(p.x, surfaceY, shot.getOwner(), weapon.getIndex());
                return 'consumed';
            }
            return hit ? 'detonate' : 'continue';

        case EXT.SENTRY:
            if (belowSurface) {
                world.deploySentry(p.x, surfaceY, shot.getOwner(), weapon.getIndex());
                return 'consumed';
            }
            return hit ? 'detonate' : 'continue';

        default:
            // Ballistic (Shell/Bomb/Rocket/Dirt/Cleaner/NUKE/DOT/Organic/Missile/Tracer/Death).
            return (hit || belowSurface) ? 'detonate' : 'continue';
    }
}

// Digger/Escape bore depth limit (px below the entry surface) and per-step bore radius.
const DIG_DEPTH = 90;

function diggerBore(shot: CShot): number {
    return Math.max(6, Math.floor(shot.getRadius() * 0.5));
}

function rollerStep(shot: CShot, world: ShotWorld, surfaceY: number, hit: CTank | null): FlyAction {
    if (hit) return 'detonate';
    const land = world.land;
    const p = shot.getPosition();
    if (p.y < surfaceY - 6) return 'continue';   // still airborne, keep arcing

    // On the surface: snap to it and roll toward the lower neighbour.
    const left = land.getHeightAt(Math.max(0, Math.floor(p.x) - 2));
    const right = land.getHeightAt(Math.min(land.width - 1, Math.floor(p.x) + 2));
    shot.setPosition(p.x, surfaceY);

    if (!shot.grounded) {
        shot.grounded = true;
        // Sitting in a pit (both neighbours higher on screen = smaller Y) → detonate.
        if (left < surfaceY && right < surfaceY) return 'detonate';
    }
    // Rising wall ahead in the direction of travel → detonate.
    const vx = shot.getVelocity().x;
    if (vx > 0 && right < surfaceY - 2) return 'detonate';
    if (vx < 0 && left < surfaceY - 2) return 'detonate';

    // Roll toward the lower neighbour (lower = larger screen-Y).
    const dir = right > left ? 1 : left > right ? -1 : (Math.sign(vx) || 1);
    shot.setVelocity(dir * ROLL_SPEED, 0);
    return 'continue';
}

/** Battery: every batSec while a primary descends, drop one bomblet straight down. */
function batteryTick(shot: CShot, weapon: CWeapon, world: ShotWorld, _dt: number): void {
    const batSec = weapon.getBatterySeconds();
    if (batSec <= 0 || shot.getGeneration() !== 0 || !shot.isMovingDown()) return;
    // Reuse the age clock as the accumulator: drop when we cross each batSec boundary.
    const now = shot.getAge();
    const due = Math.floor(now / batSec);
    if (due <= shot.batteryDrops) return;
    shot.batteryDrops = due;
    const p = shot.getPosition();
    const child = new CShot();
    child.initFromVelocity(p, 0, 0, weapon.getDamage(), weapon.getRadius(), shot.getOwner());
    child.setWeaponIndex(weapon.getIndex());
    child.setGeneration(1);
    world.spawnShot(child);
}

/**
 * Detonate a shot: FX + terrain effect + blast damage + radiation + cluster.
 * extType tweaks the terrain effect (Dirt raises, Beam craters nothing) and adds
 * a tracer marker; everything else is common.
 */
export function weaponDetonate(shot: CShot, weapon: CWeapon, world: ShotWorld): void {
    shot.kill();
    const pos = shot.getPosition();
    const land = world.land;
    const isPrimary = shot.getGeneration() === 0;
    const ext = weapon.getExtType();
    const isBeam = ext === EXT.BEAM || ext === EXT.BEAM2;
    // Cleaner (Cleaner/Plower/Dirt Destroy/Earth Destroy): a large-radius EARTH-REMOVER
    // to unbury a tank — it just carves terrain. No blast damage, no ejecta, no shake.
    const isCleaner = weapon.getType() === 'Cleaner';
    // Explosion Size (Gameplay) scales the blast radius → crater, damage reach and FX.
    const radiusPx = shot.getRadius() * GameConfig.explosionScale;
    const surfaceY = land.getHeightAt(Math.floor(pos.x));

    world.explode(pos.x, pos.y, isPrimary ? 1.5 : 0.9, weapon.getColor(), radiusPx, weapon.isNuclear(), weapon.getBlastParticle(), weapon.getExpType(), weapon.getExpBitmap());
    world.hitSound(weapon.getHitSound(), pos.x);   // soundHit, panned to the blast
    if (!isCleaner) world.shake(isPrimary ? 8 : 3, 0.3);

    // Terrain effect.
    const earth = weapon.getEarth();
    if (earth > 0) {
        // Dirt: deposit a mound instead of a crater (debris settles into a deposit).
        land.raiseTerrain(Math.floor(pos.x), Math.floor(surfaceY), radiusPx, earth);
    } else if (isCleaner) {
        // Cleaner: carve out its (large) radius — remove terrain, nothing else. No
        // scorch (it isn't a burn) and no ejecta (it clears dirt, doesn't throw it).
        land.blastCircle(Math.floor(pos.x), Math.floor(pos.y), radiusPx);
    } else if (!isBeam) {
        // Nukes (expType 4) blow a much wider crater than their base radius.
        const heavy = weapon.getExpType() === 4 || weapon.isNuclear();
        const craterR = Math.round(radiusPx * (heavy ? 1.35 : 1));
        land.blastCircle(Math.floor(pos.x), Math.floor(pos.y), craterR);
        land.scorch(Math.floor(pos.x), Math.floor(surfaceY), craterR);   // blackened blast rim
        // Eject a dirt spray scaled by the crater size — the chunks fly out and settle,
        // each RAISING the column where it lands, so a big blast piles rim mounds
        // (crater centre down, rim up) rather than just flattening the surface. Nukes
        // throw a huge amount of ejecta that fills the crater bowl.
        const chunks = Math.min(6500, Math.round(radiusPx * (heavy ? 42 : 9)) + 40);
        land.addShowerParticles(Math.floor(pos.x), Math.floor(Math.min(pos.y, surfaceY)), chunks, Math.round(radiusPx * (heavy ? 1.6 : 1)));
    }

    // The screen refraction / shockwave warp is a NUKE-only effect.
    if (isPrimary && (weapon.isNuclear() || weapon.getExpType() === 4)) {
        world.ripple(pos.x, pos.y, 2.6 + radiusPx / 120);
    }

    if (ext === EXT.TRACER) world.aimMarker(pos.x, pos.y);

    // Damage: beams do full damage to what they touch; everything else falls off.
    // Cleaners deal NO damage — they only reshape terrain.
    if (!isCleaner) world.applyBlast(pos, radiusPx, shot.getDamage(), shot.getOwner(), isBeam);

    // Radiation zone (NUKE/DOT/Organic/…): irDmg/sec for irTime s, tinted irRGB.
    // The fallout scatters as a speck cloud out of the crater — each speck lands at
    // `dist = rand01 * radius` and the density is ∝ radius. So the zone spreads within
    // the BLAST RADIUS, never a separate scale. `iradiate` is only the on/off gate
    // (tested as `threshold < iradiate`, already covered by rad.time/rad.dmg > 0 here) —
    // it is NOT a spatial radius, so it must not size the zone. Nukes throw a slightly
    // wider field, tracking their heavier (×1.35) crater.
    const rad = weapon.getRadiation();
    if (rad.time > 0 && rad.dmg > 0) {
        const big = weapon.getExpType() === 4 || weapon.isNuclear();
        const zoneR = Math.round(radiusPx * (big ? 1.4 : 1));
        land.blastIradiate(Math.floor(pos.x), Math.floor(surfaceY), zoneR, rad.dmg * 60, rad.time, rad.rgb);
    }

    spawnCluster(shot, weapon, world, pos);
}

/**
 * Cluster: on detonation spawn cluNum submunitions at the impact point, fanning
 * cluStart→cluEnd degrees, each at 0.5x power, re-clustering until the generation
 * reaches cluRecurse. Angle convention: vel = (cos a°, sin a°) (90°=down).
 */
export function spawnCluster(parent: CShot, weapon: CWeapon, world: ShotWorld, pos: Vec2): void {
    const cluNum = weapon.getClusterCount();
    if (cluNum <= 0) return;
    const gen = parent.getGeneration();
    if (gen >= weapon.getClusterRecurse()) return;

    const [startDeg, endDeg] = weapon.getClusterSpread();
    const step = (endDeg - startDeg) / cluNum;
    const childPower = Math.max(1, parent.getPower() * CLUSTER_POWER);
    const speed = childPower * SPEED_SCALE * GameConfig.powerScale;

    for (let k = 0; k < cluNum; k++) {
        const aDeg = startDeg - k * step;            // fan angle by subtraction
        const a = (aDeg * Math.PI) / 180;
        const vx = Math.cos(a) * speed;
        const vy = Math.sin(a) * speed;              // screen-Y down: 90°→down, 270°→up

        const child = new CShot();
        child.initFromVelocity(pos, vx, vy, weapon.getDamage(), weapon.getRadius(), parent.getOwner());
        child.setWeaponIndex(weapon.getIndex());
        child.setGeneration(gen + 1);
        child.setPower(childPower);
        world.spawnShot(child);
    }
}
