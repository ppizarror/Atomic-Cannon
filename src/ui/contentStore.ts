/**
 * Persisted Game Content selection — which weapons / landscapes the player has
 * disabled in the "Define Weapons" / "Define Landscapes" editors. Stored as the set
 * of DISABLED indices (empty = all enabled) in localStorage, signal-backed so the
 * editors re-render on toggle. Applied to the live game at the next `startGame`
 * (see ui/applySettings → core/CGameContent), so editing never disturbs the running
 * match — matching the option's "(quits current game)"-style deferral.
 */
import {WEAPON_DATABASE} from '../core/CWeapon';
import {createPersistedSignal} from './persistedSignal';

const KEY_W = 'atomic.content.weaponsOff';
const KEY_L = 'atomic.content.landsOff';

// Weapons default to enabled EXCEPT the secret "Organic" set (Pig Blaster, Cowinator,
// Toxic Cow, Defiled Pig), which start disabled.
const isOrganic = (i: number): boolean => {
  const w = WEAPON_DATABASE[i] as {type?: string; secret?: number};
  return w?.type === 'Organic' || w?.secret === 1;
};
const defaultWeaponsOff = (): number[] => WEAPON_DATABASE.map((_, i) => i).filter(isOrganic);

// Stored as the array of disabled indices; revived into a Set for O(1) membership tests.
const disabledStore = (key: string, seed: () => number[]) =>
  createPersistedSignal<Set<number>>(key, {
    revive: raw => new Set(raw as number[]),
    seed: () => new Set(seed()),
    encode: s => [...s],
  });

const weaponsStore = disabledStore(KEY_W, defaultWeaponsOff);
const landsStore = disabledStore(KEY_L, () => []);
export const weaponsOff = weaponsStore.signal;
export const landsOff = landsStore.signal;

export const isWeaponOff = (i: number): boolean => weaponsOff.value.has(i);
export const isLandOff = (i: number): boolean => landsOff.value.has(i);

export function toggleWeapon(i: number): void {
  const s = new Set(weaponsOff.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  weaponsStore.set(s);
}

export function toggleLand(i: number): void {
  const s = new Set(landsOff.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  landsStore.set(s);
}
