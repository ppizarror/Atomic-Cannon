/**
 * Persisted Game Content selection — which weapons / landscapes the player has
 * disabled in the "Define Weapons" / "Define Landscapes" editors. Signal-backed so the
 * editors re-render on toggle, and applied to the live game at the next `startGame`
 * (see ui/applySettings → core/CGameContent), so editing never disturbs the running
 * match — matching the option's "(quits current game)"-style deferral.
 */
import {WEAPON_DATABASE} from '../core/CWeapon';
import {createPersistedSignal} from './persistedSignal';

const KEY_W = 'atomic.content.weaponsOff';
const KEY_L = 'atomic.content.landsOff';

/** Weapons that start switched off, straight from the data: `"disabled": true` on the row. */
const defaultWeaponsOff = (): number[] => WEAPON_DATABASE.filter(w => w.disabled).map(w => w.index);

/**
 * Disabled weapon indices for a persisted value. `{id: enabled}` is the current shape, holding
 * only the player's overrides; a bare array is a pre-id save holding disabled INDICES, read
 * once and then re-written by id.
 */
export function weaponsOffFromStored(raw: unknown): Set<number> {
  if (Array.isArray(raw)) return new Set([...(raw as number[]), ...defaultWeaponsOff()]);
  const stored = (raw ?? {}) as Record<string, unknown>;
  const off = new Set<number>();
  for (const w of WEAPON_DATABASE) {
    const saved = stored[w.id];
    const enabled = typeof saved === 'boolean' ? saved : !w.disabled;
    if (!enabled) off.add(w.index);
  }
  return off;
}

/** The inverse: `{id: enabled}` for the weapons whose state DIFFERS from the data's default,
 *  and nothing else — so an untouched profile stores `{}` and later edits to a weapon's
 *  `"disabled"` flag still reach every player who never overrode that weapon. */
export function weaponsOffToStored(off: Set<number>): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  for (const w of WEAPON_DATABASE) {
    const isOff = off.has(w.index);
    if (isOff !== !!w.disabled) overrides[w.id] = !isOff;
  }
  return overrides;
}

const weaponsStore = createPersistedSignal<Set<number>>(KEY_W, {
  revive: weaponsOffFromStored,
  seed: () => new Set(defaultWeaponsOff()),
  encode: weaponsOffToStored,
});

const landsStore = createPersistedSignal<Set<number>>(KEY_L, {
  revive: raw => new Set(raw as number[]),
  seed: () => new Set<number>(),
  encode: s => [...s],
});

export const weaponsOff = weaponsStore.signal;
export const landsOff = landsStore.signal;

export const isWeaponOff = (i: number): boolean => weaponsOff.value.has(i);
export const isLandOff = (i: number): boolean => landsOff.value.has(i);

/** Flip index `i` in a disabled-set store (add if absent, remove if present), persisting the result. */
function toggleIn(store: typeof weaponsStore, i: number): void {
  const s = new Set(store.signal.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  store.set(s);
}

export const toggleWeapon = (i: number): void => toggleIn(weaponsStore, i);
export const toggleLand = (i: number): void => toggleIn(landsStore, i);
