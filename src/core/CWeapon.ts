/**
 * CWeapon - weapon definitions, loaded from the bundled game data.
 *
 * Source of truth is `data/weapons.json` (104 weapons parsed from weapons.txt) —
 * NOT a hardcoded list. Colors come from `data/particles.json` (each weapon's
 * blast/trail particle effect).
 */

import weaponsRaw from '../data/weapons.json';
import particlesRaw from '../data/particles.json';

// The 20 weapon type strings present in the data.
export type WeaponType =
    | 'Airburst' | 'Beam' | 'Bomb' | 'Cleaner' | 'DOT' | 'Death' | 'Digger'
    | 'Dirt' | 'Escape' | 'Mine' | 'Missile' | 'NUKE' | 'Organic' | 'Rebound'
    | 'Rocket' | 'Roller' | 'Sentry' | 'Shell' | 'Tracer' | 'Utility' | string;

/** One row of data/weapons.json (46-column schema from weapons.txt). */
export interface RawWeapon {
    name: string;
    type: WeaponType;
    bitmap: string;
    size: number;
    damage: number;
    radius: number;
    cost: number;
    variance: number;
    spawn: number;
    spread: number;
    sucNum: number;
    sucSec: number;
    batSec: number;
    cluNum: number;
    cluStart: number;
    cluEnd: number;
    cluRecurse: number;
    earth: number;
    crackle: number;
    fodder: number;
    trail: string;
    blast: string;
    soundFire: string;
    soundHit: string;
    trailType: number;
    trailLength: number;
    flareParam: number;
    flareType: number;
    flareBmp: string;
    flareSize: number;
    muzzleFlash: number;
    muzzleSmoke: number;
    extType: number;
    iradiate: number;
    irDmg: number;
    irTime: number;
    irRed: number;
    irGreen: number;
    irBlue: number;
    expType: number;
    expBitmap: string;
    desc: string;

    [k: string]: unknown;
}

interface ParticleDef {
    colorr: number;
    colorg: number;
    colorb: number;

    [k: string]: number;
}

const RAW = weaponsRaw as unknown as RawWeapon[];
const PARTICLES = particlesRaw as unknown as Record<string, ParticleDef>;

// Types that add/remove terrain rather than just damage.
const DIGGING_TYPES = new Set<WeaponType>(['Digger', 'Dirt', 'Cleaner', 'Roller']);

function hex(r: number, g: number, b: number): string {
    const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

/** A weapon's on-screen tint, from its blast (else trail) particle effect. */
function weaponColor(w: RawWeapon): string {
    const p = PARTICLES[w.blast] || PARTICLES[w.trail];
    return p ? hex(p.colorr, p.colorg, p.colorb) : '#ffaa00';
}

export interface WeaponDef extends RawWeapon {
    index: number;
    color: string;
}

export const WEAPON_DATABASE: WeaponDef[] = RAW.map((w, i) => ({
    ...w,
    index: i,
    color: weaponColor(w),
}));

/** Index of the first plain Shell — a sensible default/starter weapon. */
export function getDefaultWeaponIndex(): number {
    const i = WEAPON_DATABASE.findIndex(w => w.type === 'Shell');
    return i >= 0 ? i : 0;
}

export class CWeapon {

    private m_def: WeaponDef;

    constructor(defOrIndex: WeaponDef | number) {
        this.m_def = typeof defOrIndex === 'number'
            ? (WEAPON_DATABASE[defOrIndex] || WEAPON_DATABASE[0])
            : defOrIndex;
    }

    getDef(): WeaponDef {
        return this.m_def;
    }

    getName(): string {
        return this.m_def.name;
    }

    getIndex(): number {
        return this.m_def.index;
    }

    /** Projectile sprite file under assets/weapons/ (e.g. "missile.bmp"). */
    getBitmap(): string {
        return this.m_def.bitmap;
    }

    /** Authored projectile size (drives on-screen sprite scale). */
    getSize(): number {
        return this.m_def.size || 12;
    }

    getType(): WeaponType {
        return this.m_def.type;
    }

    getDamage(): number {
        return this.m_def.damage;
    }

    getRadius(): number {
        return this.m_def.radius;
    }

    getCost(): number {
        return this.m_def.cost;
    }

    getColor(): string {
        return this.m_def.color;
    }

    getDescription(): string {
        return this.m_def.desc;
    }

    isNuclear(): boolean {
        return this.m_def.type === 'NUKE';
    }

    isRadioactive(): boolean {
        return (this.m_def.iradiate || 0) > 0 || this.isNuclear();
    }

    digsTerrain(): boolean {
        return DIGGING_TYPES.has(this.m_def.type);
    }

    // --- mechanics for CShot (Phase 3) -----------------------------------------
    // extType is the behaviour dispatcher — see weapon_types.md.
    getExtType(): number {
        return this.m_def.extType || 0;
    }

    // Cluster: cluNum submunitions on detonation, fanning cluStart..cluEnd, at 0.5x power,
    // re-clustering until generation reaches cluRecurse.
    getClusterCount(): number {
        return this.m_def.cluNum || 0;
    }

    getClusterSpread(): [number, number] {
        return [this.m_def.cluStart || 0, this.m_def.cluEnd || 0];
    }

    getClusterRecurse(): number {
        return this.m_def.cluRecurse || 0;
    }

    // Battery: drop a bomblet straight down every batSec seconds while descending.
    getBatterySeconds(): number {
        return this.m_def.batSec || 0;
    }

    // Multi-fire fields: `spawn` = the number of SIMULTANEOUS rounds fired in a fan;
    // `spread` = degrees BETWEEN those rounds; `sucNum` = SUCCESSION — the shot fires
    // `sucNum+1` times in a row (`sucSec` apart). So a Cannon (spawn 5) sprays 5
    // pellets; a Machine Gun (sucNum 11) fires ~12 times. (The weapons.txt column
    // NAMES are misleading.)
    getSpawnCount(): number {
        return this.m_def.spawn || 1;                 // simultaneous fan count
    }

    getFanSpacingDeg(): number {
        return this.m_def.spread || 0;                // degrees between fanned rounds
    }

    getSuccessionCount(): number {
        return Math.max(0, this.m_def.sucNum || 0);   // extra salvos fired in succession
    }

    getSuccessionSec(): number {
        return this.m_def.sucSec || 0;                // time window for the succession burst
    }

    getVariance(): number {
        return this.m_def.variance || 0;
    }

    // Terrain shaping: Dirt raises terrain by `earth`; digging types remove it.
    getEarth(): number {
        return this.m_def.earth || 0;
    }

    // Radiation zone (NUKE / DOT): irDmg per second for irTime seconds; irRGB tints it.
    getRadiation(): { amount: number; dmg: number; time: number; rgb: [number, number, number] } {
        return {
            amount: this.m_def.iradiate || 0,
            dmg: this.m_def.irDmg || 0,
            time: this.m_def.irTime || 0,
            rgb: [this.m_def.irRed || 0, this.m_def.irGreen || 0, this.m_def.irBlue || 0],
        };
    }

    // --- effects ---------------------------------------------------------------
    getBlastParticle(): string {
        return this.m_def.blast;
    }

    getTrailParticle(): string {
        return this.m_def.trail;
    }

    getFireSound(): string {
        return this.m_def.soundFire;
    }

    getHitSound(): string {
        return this.m_def.soundHit;
    }

    getFlareBitmap(): string {
        return this.m_def.flareBmp || this.m_def.expBitmap;
    }

    /** Explosion style 0–4 (4 = nuke: biggest + full-screen white flash). */
    getExpType(): number {
        return this.m_def.expType || 0;
    }

    /** The weapon's explosion flare sprite, e.g. `flares/00.bmp`. */
    getExpBitmap(): string {
        return this.m_def.expBitmap || '';
    }

    // --- trail / muzzle / in-flight flare (weapons.txt fields) ----------
    /** 0 = no trail, 1 = basic flare+smoke, 2–6 = rocket-plume exhaust. */
    getTrailType(): number {
        return this.m_def.trailType || 0;
    }

    /** Trail persistence (0 = short, up to ~100 = long rocket trail). */
    getTrailLength(): number {
        return this.m_def.trailLength || 0;
    }

    getMuzzleFlash(): number {
        return this.m_def.muzzleFlash || 0;
    }

    getMuzzleSmoke(): number {
        return this.m_def.muzzleSmoke || 0;
    }

    /** In-flight glowing flare sprite on the projectile (rockets), else ''. */
    getInFlightFlare(): string {
        return this.m_def.flareType ? `flares/${this.m_def.flareBmp}` : '';
    }

    getFlareSize(): number {
        return this.m_def.flareSize || 0;
    }
}

// ---------------------------------------------------------------------------
// Derived weapon stats shown in the weapon-details LCD / depot.
//
// These are NOT columns in weapons.txt — they're computed once at weapon-load
// (CWeapon post-parse) and stored as Power and Damage-per-area. Reference stat
// anchors:
//   Shell 50 · Rocket 100 · Earth Destroy 25 · Plutonium Nuke 650 · Toxic Cow 700.
// ---------------------------------------------------------------------------

/** The weapon's "effective impact count" multiplier `m` — the first half of the
 *  Power derivation. Starts at 1, is OVERWRITTEN by spawn, then multiplied by the
 *  battery / succession / cluster factors (they compound). Cluster is integer
 *  `cluNum^cluRecurse`, except cluNum==1 which sets m = cluRecurse outright. */
function impactMultiplier(w: RawWeapon): number {
    let m = 1;
    if ((w.spawn ?? 0) > 0) m = w.spawn;                     // m = spawn (assign)
    if ((w.batSec ?? 0) > 0) m = m * w.batSec * 3;           // × batSec × 3
    if ((w.sucNum ?? 0) > 0) m = m * (w.sucNum + 1);         // × (sucNum + 1)
    if (w.cluNum === 1) m = w.cluRecurse;                    // cluNum==1: m = cluRecurse
    else if ((w.cluNum ?? 0) > 0)                            // else: × cluNum^cluRecurse (int)
        m = m * Math.pow(Math.trunc(w.cluNum), Math.trunc(w.cluRecurse ?? 0));
    return m;
}

/** Post-override Power: `m × damage`, `+200` if the weapon irradiates,
 *  or just `damage` for Utility weapons (a heal/move amount, not an attack). */
export function weaponPower(w: RawWeapon): number {
    const m = impactMultiplier(w);
    let power = m * w.damage;
    if ((w.iradiate ?? 0) > 0) power += 200;                 // iradiate > 0
    if (w.type === 'Utility') power = w.damage;              // type == "Utility"
    return Math.round(power);
}

/** Damage-per-area: `Power·10000 / (radius² · m · 6.28)` — power density
 *  over the blast footprint. Zero when the weapon has no radius or no impact. */
export function weaponDamagePerArea(w: RawWeapon): number {
    const m = impactMultiplier(w);
    if (m <= 0 || w.radius <= 0) return 0;
    let power = m * w.damage;
    if ((w.iradiate ?? 0) > 0) power += 200;
    if (w.type === 'Utility') power = w.damage;
    return Math.round((power * 10000) / (w.radius * w.radius * m * 6.28));
}

export function getWeapon(index: number): CWeapon {
    return new CWeapon(index);
}

export function getAllWeapons(): CWeapon[] {
    return WEAPON_DATABASE.map(def => new CWeapon(def));
}
