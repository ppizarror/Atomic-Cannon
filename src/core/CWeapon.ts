/**
 * CWeapon - weapon definitions, loaded from the bundled game data.
 *
 * Source of truth is `data/weapons.json`.
 */

import weaponsRaw from '../data/weapons.json';
import particlesRaw from '../data/particles.json';
import {rgbToHex} from '../math/color';
import {strings} from '../i18n';
import {type ExtType, toExtType} from './weapons/ExtType';
import {type ExpType, toExpType, isNukeExp} from './weapons/ExpType';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

// The 20 weapon type strings present in the data.
export type WeaponType =
  | 'Airburst'
  | 'Beam'
  | 'Bomb'
  | 'Cleaner'
  | 'DOT'
  | 'Death'
  | 'Digger'
  | 'Dirt'
  | 'Escape'
  | 'Mine'
  | 'Missile'
  | 'NUKE'
  | 'Organic'
  | 'Rebound'
  | 'Rocket'
  | 'Roller'
  | 'Sentry'
  | 'Shell'
  | 'Tracer'
  | 'Utility'
  | string;

/** One row of data/weapons.json. */
export interface RawWeapon {
  /** Stable slug (e.g. "magma.beam") — the engine/AI match key and the i18n key for the
   *  weapon's display name/description. NEVER localised, so game logic can rely on it. */
  id: string;
  /** Icon asset basename under assets/icons/<size>/ (lower-cased at load; e.g. "Magma Beam"). */
  icon: string;
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
  /** HOMING guidance (extType 19), all optional — a row that omits them gets the defaults below.
   *  `homMaxDeg` is the authority band either side of the apex heading: the whole character of a
   *  guided round, and the knob that separates a cheap seeker from an expensive one. `homStepDeg`
   *  / `homFineDeg` are how finely it searches that band — a coarse search is a dumber missile
   *  that settles for a worse correction, which is a legitimate way to price one down. */
  homMaxDeg?: number;
  homStepDeg?: number;
  homFineDeg?: number;
  disabled?: boolean;

  [k: string]: unknown;
}

interface ParticleDef {
  colorr: number;
  colorg: number;
  colorb: number;

  [k: string]: number;
}

// ==========================================================================
// WEAPON DATABASE
// ==========================================================================

const RAW = weaponsRaw as unknown as RawWeapon[];
const PARTICLES = particlesRaw as unknown as Record<string, ParticleDef>;

/** A weapon's on-screen tint, from its blast (else trail) particle effect. */
function weaponColor(w: RawWeapon): string {
  const p = PARTICLES[w.blast] || PARTICLES[w.trail];
  return p ? rgbToHex(p.colorr, p.colorg, p.colorb) : '#ffaa00';
}

export interface WeaponDef extends RawWeapon {
  index: number;
  color: string;
}

export const WEAPON_DATABASE: WeaponDef[] = RAW.map((w, i) => {
  // RAW is a throwaway view over the JSON, used only here — extend each entry
  // in place into a WeaponDef rather than copying.
  const def = w as WeaponDef;
  def.index = i;
  def.color = weaponColor(w);
  return def;
});

/** Localised display name for a weapon def (active locale), falling back to its id. */
export const weaponName = (w: {id: string}): string => strings.value.weapons[w.id]?.name ?? w.id;

/** Localised depot description for a weapon def (active locale), or '' when it has none. */
export const weaponDesc = (w: {id: string}): string => strings.value.weapons[w.id]?.desc ?? '';

/** Localised label for a weapon category (`type` discriminant), falling back to the type. */
export const weaponTypeName = (type: string): string => strings.value.weaponTypes[type] ?? type;

/** Index of the first plain Shell — a sensible default/starter weapon. */
export function getDefaultWeaponIndex(): number {
  const i = WEAPON_DATABASE.findIndex(w => w.type === 'Shell');
  return i >= 0 ? i : 0;
}

/** Blast radius (px) at/above which a detonation counts as "big" — triggers the heavy
 *  camera shake / screen-flash / wide-fallout FX (the tier nuke-class weapons always hit).
 *  Below it (machine-gun r8, shell/cannon r≈20) the impact is silent-camera; bombs/rockets
 *  (r≈50) and nukes shake. */
export const BIG_BLAST_RADIUS = 45;

// ==========================================================================
// CWeapon CLASS
// ==========================================================================

export class CWeapon {
  private m_def: WeaponDef;

  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================

  constructor(defOrIndex: WeaponDef | number) {
    this.m_def =
      typeof defOrIndex === 'number'
        ? WEAPON_DATABASE[defOrIndex] || WEAPON_DATABASE[0]
        : defOrIndex;
  }

  // ========================================================================
  // ACCESSORS & QUERIES
  // ========================================================================

  /** Stable, never-localised match key (data/weapons.json `id`). */
  getId(): string {
    return this.m_def.id;
  }

  /** Localised display name for the active locale (falls back to the id). */
  getName(): string {
    return weaponName(this.m_def);
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

  isNuclear(): boolean {
    return this.m_def.type === 'NUKE';
  }

  /** "Nuke-class" blast — the top explosion tier ({@link EXP.NUKE}) or an actual NUKE. Drives the
   *  heavy shake / full-screen flash / big-fallout branches. */
  isNukeClass(): boolean {
    return isNukeExp(this.getExpType()) || this.isNuclear();
  }

  /** Cleaner-family (Cleaner/Plower/Dirt Destroy/Earth Destroy): a large-radius EARTH-REMOVER
   *  that carves terrain to unbury a tank — no blast damage, no ejecta, no fiery white-out. */
  isCleaner(): boolean {
    return this.getType() === 'Cleaner';
  }

  /** Big enough for the heavy blast FX: nuke-class, or a wide conventional hit
   *  (radiusPx ≥ BIG_BLAST_RADIUS). */
  isBigBlast(radiusPx: number): boolean {
    return this.isNukeClass() || radiusPx >= BIG_BLAST_RADIUS;
  }

  isRadioactive(): boolean {
    return (this.m_def.iradiate || 0) > 0 || this.isNuclear();
  }

  // ---- PROJECTILE MECHANICS ----------------------------------------------
  // For CShot.
  // extType is the behaviour dispatcher — narrowed from the raw JSON number to the
  // authoritative ExtType union (unknown/missing → BALLISTIC) so it can't be misrouted.
  getExtType(): ExtType {
    return toExtType(this.m_def.extType || 0);
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
  // pellets; a Machine Gun (sucNum 11) fires ~12 times. (The original column
  // NAMES are misleading.)
  getSpawnCount(): number {
    return this.m_def.spawn || 1; // simultaneous fan count
  }

  getFanSpacingDeg(): number {
    return this.m_def.spread || 0; // degrees between fanned rounds
  }

  getSuccessionCount(): number {
    return Math.max(0, this.m_def.sucNum || 0); // extra salvos fired in succession
  }

  getSuccessionSec(): number {
    return this.m_def.sucSec || 0; // time window for the succession burst
  }

  getVariance(): number {
    return this.m_def.variance || 0;
  }

  // Terrain shaping: Dirt raises terrain by `earth`; digging types remove it.
  getEarth(): number {
    return this.m_def.earth || 0;
  }

  // Blast FX intensity (0..~0.7): drives the DEBRIS/ejecta chunk count thrown from the crater
  // (`fodder`) and the SCORCH/burnt-rim darkening (`crackle`) — the original scales each per
  // weapon by these fields (a Shell has neither; a nuke throws lots of both). Also the "Fodder"
  // stat shown in the weapon info.
  getFodder(): number {
    return this.m_def.fodder || 0;
  }

  getCrackle(): number {
    return this.m_def.crackle || 0;
  }

  // Radiation zone (NUKE / DOT): irDmg per second for irTime seconds; irRGB tints it.
  getRadiation(): {amount: number; dmg: number; time: number; rgb: [number, number, number]} {
    return {
      amount: this.m_def.iradiate || 0,
      dmg: this.m_def.irDmg || 0,
      time: this.m_def.irTime || 0,
      rgb: [this.m_def.irRed || 0, this.m_def.irGreen || 0, this.m_def.irBlue || 0],
    };
  }

  // ---- EFFECTS -----------------------------------------------------------
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

  /** Explosion style as the authoritative {@link ExpType} token ({@link EXP.NUKE} = biggest +
   *  full-screen white flash). Narrowed from the raw JSON field so callers can't compare bare
   *  numbers (`=== 4`) — only `=== EXP.NUKE`. */
  getExpType(): ExpType {
    return toExpType(this.m_def.expType || 0);
  }

  /** The weapon's explosion flare sprite, e.g. `flares/00.bmp`. */
  getExpBitmap(): string {
    return this.m_def.expBitmap || '';
  }

  // ---- TRAIL / MUZZLE / FLARE --------------------------------------------
  /** 0 = no trail, 1 = basic flare+smoke, 2–6 = rocket-plume exhaust. */
  getTrailType(): number {
    return this.m_def.trailType || 0;
  }

  /** Trail persistence (0 = short, up to ~100 = long rocket trail). */
  getTrailLength(): number {
    return this.m_def.trailLength || 0;
  }

  // --- homing guidance (extType 19) ------------------------------------------
  // Defaults live here rather than in the behaviour, so a row that omits the fields still reads
  // as a complete weapon. They are the values the Homing Missile shipped with.

  /** Course-correction authority, degrees either way, measured from the APEX heading. */
  getHomingMaxTurn(): number {
    return this.m_def.homMaxDeg ?? 15;
  }

  /** Coarse search resolution across that band. */
  getHomingStep(): number {
    return Math.max(0.05, this.m_def.homStepDeg ?? 1);
  }

  /** Refinement resolution around the coarse winner. */
  getHomingFineStep(): number {
    return Math.max(0.01, this.m_def.homFineDeg ?? 0.1);
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

// ==========================================================================
// DERIVED WEAPON STATS
//
// Shown in the weapon-details LCD / depot. These are NOT columns in the source
// data — they're computed once at weapon-load (CWeapon post-parse) and stored as
// Power and Damage-per-area. Reference stat anchors:
//   Shell 50 · Rocket 100 · Earth Destroy 25 · Plutonium Nuke 650 · Toxic Cow 700.
// ==========================================================================

/** The weapon's "effective impact count" multiplier `m` — the first half of the
 *  Power derivation. Starts at 1, is OVERWRITTEN by spawn, then multiplied by the
 *  battery / succession / cluster factors (they compound). Cluster is integer
 *  `cluNum^cluRecurse`, except cluNum==1 which sets m = cluRecurse outright. */
function impactMultiplier(w: RawWeapon): number {
  let m = 1;
  if ((w.spawn ?? 0) > 0) m = w.spawn; // m = spawn (assign)
  if ((w.batSec ?? 0) > 0) m = m * w.batSec * 3; // × batSec × 3
  if ((w.sucNum ?? 0) > 0) m = m * (w.sucNum + 1); // × (sucNum + 1)
  if (w.cluNum === 1)
    m = w.cluRecurse; // cluNum==1: m = cluRecurse
  else if ((w.cluNum ?? 0) > 0)
    // else: × cluNum^cluRecurse (int)
    m = m * Math.pow(Math.trunc(w.cluNum), Math.trunc(w.cluRecurse ?? 0));
  return m;
}

/** Post-override Power BEFORE rounding: `m × damage`, `+200` if the weapon irradiates,
 *  or just `damage` for Utility weapons (a heal/move amount, not an attack). Shared by
 *  weaponPower + weaponDamagePerArea so the derivation can't drift between them. */
function basePower(w: RawWeapon, m: number): number {
  if (w.type === 'Utility') return w.damage; // Utility overrides: the raw heal/move amount
  return m * w.damage + ((w.iradiate ?? 0) > 0 ? 200 : 0);
}

/** Power stat shown in the weapon-details LCD / depot. */
export function weaponPower(w: RawWeapon): number {
  return Math.round(basePower(w, impactMultiplier(w)));
}

/** Damage-per-area: `Power·10000 / (radius² · m · 6.28)` — power density
 *  over the blast footprint. Zero when the weapon has no radius or no impact. */
export function weaponDamagePerArea(w: RawWeapon): number {
  const m = impactMultiplier(w);
  if (m <= 0 || w.radius <= 0) return 0;
  return Math.round((basePower(w, m) * 10000) / (w.radius * w.radius * m * 6.28));
}

/**
 * Every weapon index whose entry satisfies `pred`, in database order — the
 * `for (let i = 0; i < WEAPON_DATABASE.length; i++) if (…) out.push(i)` sweep that a dozen
 * call sites across the controller, the economy and the bot AI each spelled out by hand.
 *
 * Cheap enough to call per turn (the database is ~100 entries and the predicates are field
 * reads); the few results that are genuinely static are memoised by their own callers.
 */
export function weaponIndices(pred: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < WEAPON_DATABASE.length; i++) if (pred(i)) out.push(i);
  return out;
}

/** Whether ANY weapon index satisfies `pred` — the early-out form of {@link weaponIndices}. */
export function someWeapon(pred: (i: number) => boolean): boolean {
  for (let i = 0; i < WEAPON_DATABASE.length; i++) if (pred(i)) return true;
  return false;
}

export function getWeapon(index: number): CWeapon {
  return new CWeapon(index);
}
