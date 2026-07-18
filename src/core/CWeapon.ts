/**
 * CWeapon - Weapon Definition Class
 */

export enum EWeaponType {
  Standard = 'Standard',
  Airburst = 'Airburst',
  Beam = 'Beam',
  Mine = 'Mine',
  Digger = 'Digger',
  Cleaner = 'Cleaner',
  Nuclear = 'Nuclear',
  Rebound = 'Rebound',
}

export interface WeaponDef {
  index: number;
  name: string;
  damage: number;
  radius: number;
  speed: number;
  cost: number;
  type: EWeaponType;
  color: string;
  isNuclear?: boolean;
  digsTerrain?: boolean;
  bounces?: number;
}

export const WEAPON_DATABASE: WeaponDef[] = [
  {
    index: 0,
    name: 'Standard',
    damage: 50,
    radius: 40,
    speed: 1.0,
    cost: 100,
    type: EWeaponType.Standard,
    color: '#ffff00'
  },
  {
    index: 1,
    name: 'Grenade',
    damage: 60,
    radius: 50,
    speed: 0.8,
    cost: 150,
    type: EWeaponType.Airburst,
    color: '#ff8800'
  },
  {
    index: 2,
    name: 'Cluster Bomb',
    damage: 40,
    radius: 35,
    speed: 0.6,
    cost: 200,
    type: EWeaponType.Airburst,
    color: '#ff4444'
  },
  {
    index: 3,
    name: 'Sonic Boom',
    damage: 80,
    radius: 30,
    speed: 5.0,
    cost: 250,
    type: EWeaponType.Beam,
    color: '#00ffff'
  },
  {
    index: 4,
    name: 'Mine',
    damage: 150,
    radius: 60,
    speed: 0,
    cost: 300,
    type: EWeaponType.Mine,
    color: '#ff0066'
  },
  {
    index: 5,
    name: 'Digger',
    damage: 70,
    radius: 45,
    speed: 0.3,
    cost: 180,
    type: EWeaponType.Digger,
    color: '#8B4513',
    digsTerrain: true
  },
  {
    index: 6,
    name: 'Dirt Rocket',
    damage: 30,
    radius: 35,
    speed: 1.2,
    cost: 120,
    type: EWeaponType.Cleaner,
    color: '#654321'
  },
  {
    index: 7,
    name: 'Nuclear',
    damage: 200,
    radius: 100,
    speed: 0.5,
    cost: 500,
    type: EWeaponType.Nuclear,
    color: '#ff4400',
    isNuclear: true
  },
  {
    index: 8,
    name: 'Dirty Nuclear',
    damage: 50,
    radius: 80,
    speed: 0.4,
    cost: 450,
    type: EWeaponType.Nuclear,
    color: '#aa2200',
    isNuclear: true
  },
  {
    index: 9,
    name: 'Bouncer',
    damage: 45,
    radius: 40,
    speed: 1.5,
    cost: 175,
    type: EWeaponType.Rebound,
    color: '#00ff88',
    bounces: 2
  },
];

export class CWeapon {

  constructor(defOrIndex: WeaponDef | number) {
    if (typeof defOrIndex === 'number') {
      this.m_def = WEAPON_DATABASE[defOrIndex] || WEAPON_DATABASE[0];
    } else {
      this.m_def = defOrIndex;
    }
    
    this.m_pSpriteIcon = null;
    this.m_pFlareSprite = null;
  }

  getName(): string { return this.m_def.name; }
  getIndex(): number { return this.m_def.index; }

  getDamage(): number { return this.m_def.damage; }
  getRadius(): number { return this.m_def.radius; }
  getSpeed(): number { return this.m_def.speed; }
  getCost(): number { return this.m_def.cost; }
  getType(): EWeaponType { return this.m_def.type; }

  getColor(): string { return this.m_def.color; }

  isNuclear(): boolean { return !!this.m_def.isNuclear; }
  digsTerrain(): boolean { return !!this.m_def.digsTerrain; }

  private m_def: WeaponDef;
  public m_pSpriteIcon: unknown = null;
  public m_pFlareSprite: unknown = null;
}

export function getWeapon(index: number): CWeapon {
  return new CWeapon(index);
}

export function getAllWeapons(): CWeapon[] {
  return WEAPON_DATABASE.map(def => new CWeapon(def));
}
