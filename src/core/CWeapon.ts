/**
 * CWeapon - weapon definitions, loaded from the extracted game data.
 *
 * Source of truth is `data/weapons.json` (104 weapons parsed from the original
 * weapons.txt) — NOT a hardcoded list. Colors come from `data/particles.json`
 * (each weapon's blast/trail particle effect).
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
  sucNum: number; sucSec: number; batSec: number;
  cluNum: number; cluStart: number; cluEnd: number; cluRecurse: number;
  earth: number; crackle: number; fodder: number;
  trail: string; blast: string;
  soundFire: string; soundHit: string;
  flareParam: number; flareBmp: string; flareSize: number;
  muzzleFlash: number; muzzleSmoke: number;
  extType: number;
  iradiate: number; irDmg: number; irTime: number;
  irRed: number; irGreen: number; irBlue: number;
  expType: number; expBitmap: string;
  desc: string;
  [k: string]: unknown;
}

interface ParticleDef { colorr: number; colorg: number; colorb: number; [k: string]: number; }

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

  getDef(): WeaponDef { return this.m_def; }
  getName(): string { return this.m_def.name; }
  getIndex(): number { return this.m_def.index; }
  getType(): WeaponType { return this.m_def.type; }
  getDamage(): number { return this.m_def.damage; }
  getRadius(): number { return this.m_def.radius; }
  getCost(): number { return this.m_def.cost; }
  getColor(): string { return this.m_def.color; }
  getDescription(): string { return this.m_def.desc; }

  isNuclear(): boolean { return this.m_def.type === 'NUKE'; }
  isRadioactive(): boolean { return (this.m_def.iradiate || 0) > 0 || this.isNuclear(); }
  digsTerrain(): boolean { return DIGGING_TYPES.has(this.m_def.type); }

  // --- mechanics for CShot (Phase 3) -----------------------------------------
  // extType (weapon+0x70) is the behaviour dispatcher — see symbols/notes/weapon_types.md.
  getExtType(): number { return this.m_def.extType || 0; }

  // Cluster: cluNum submunitions on detonation, fanning cluStart..cluEnd, at 0.5x power,
  // re-clustering until generation reaches cluRecurse.
  getClusterCount(): number { return this.m_def.cluNum || 0; }
  getClusterSpread(): [number, number] { return [this.m_def.cluStart || 0, this.m_def.cluEnd || 0]; }
  getClusterRecurse(): number { return this.m_def.cluRecurse || 0; }

  // Battery: drop a bomblet straight down every batSec seconds while descending.
  getBatterySeconds(): number { return this.m_def.batSec || 0; }

  // Multi-fire: `spread` simultaneous fanned rounds; `spawn` sequential salvos.
  getSpreadCount(): number { return this.m_def.spread || 0; }
  getSpawnCount(): number { return this.m_def.spawn || 1; }
  getVariance(): number { return this.m_def.variance || 0; }

  // Terrain shaping: Dirt raises terrain by `earth`; digging types remove it.
  getEarth(): number { return this.m_def.earth || 0; }

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
  getBlastParticle(): string { return this.m_def.blast; }
  getTrailParticle(): string { return this.m_def.trail; }
  getFireSound(): string { return this.m_def.soundFire; }
  getHitSound(): string { return this.m_def.soundHit; }
  getFlareBitmap(): string { return this.m_def.flareBmp || this.m_def.expBitmap; }
}

export function getWeapon(index: number): CWeapon {
  return new CWeapon(index);
}

export function getAllWeapons(): CWeapon[] {
  return WEAPON_DATABASE.map(def => new CWeapon(def));
}
