/**
 * Persisted Game Content selection — which weapons / landscapes the player has
 * disabled in the "Define Weapons" / "Define Landscapes" editors. Stored as the set
 * of DISABLED indices (empty = all enabled) in localStorage, signal-backed so the
 * editors re-render on toggle. Applied to the live game at the next `startGame`
 * (see ui/applySettings → core/CGameContent), so editing never disturbs the running
 * match — matching the option's "(quits current game)"-style deferral.
 */
import {signal} from '@preact/signals';
import {WEAPON_DATABASE} from '../core/CWeapon';

const KEY_W = 'atomic.content.weaponsOff';
const KEY_L = 'atomic.content.landsOff';

// Weapons default to enabled EXCEPT the secret "Organic" set (Pig Blaster, Cowinator,
// Toxic Cow, Defiled Pig), which start disabled.
const isOrganic = (i: number): boolean => {
  const w = WEAPON_DATABASE[i] as {type?: string; secret?: number};
  return w?.type === 'Organic' || w?.secret === 1;
};
const defaultWeaponsOff = (): number[] => WEAPON_DATABASE.map((_, i) => i).filter(isOrganic);

function load(key: string, fallback: () => number[]): Set<number> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set<number>(JSON.parse(raw) as number[]);
  } catch {
    /* corrupt/absent — fall through to the default */
  }
  return new Set(fallback());
}

function persist(key: string, s: Set<number>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s]));
  } catch {
    /* storage unavailable — the set still applies this session */
  }
}

export const weaponsOff = signal<Set<number>>(load(KEY_W, defaultWeaponsOff));
export const landsOff = signal<Set<number>>(load(KEY_L, () => []));

export const isWeaponOff = (i: number): boolean => weaponsOff.value.has(i);
export const isLandOff = (i: number): boolean => landsOff.value.has(i);

export function toggleWeapon(i: number): void {
  const s = new Set(weaponsOff.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  weaponsOff.value = s;
  persist(KEY_W, s);
}

export function toggleLand(i: number): void {
  const s = new Set(landsOff.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  landsOff.value = s;
  persist(KEY_L, s);
}
