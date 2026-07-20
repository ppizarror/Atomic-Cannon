/**
 * Persisted option values for the Settings tree.
 *
 * Each option lives in a single flat map (keyed by a stable id) persisted to
 * localStorage. Options that drive live
 * subsystems — Audio (CAudio) and Difficulty (the controller) — are NOT stored here;
 * their widgets bind straight to those subsystems so the menu reflects the real state
 * and there's one source of truth. Everything else is a preference we remember.
 */
import {signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';

const KEY = 'atomic.settings';

type Vals = Record<string, number>;

// Signal-backed so widgets that read it re-render on change.
const vals = signal<Vals>(loadJSON<Vals>(KEY, {}));

/** Current value for `id`, or `dflt` if never set. */
export function getVal(id: string, dflt: number): number {
  const v = vals.value[id];
  return v === undefined ? dflt : v;
}

/** Set `id` and persist the whole map. */
export function setVal(id: string, v: number): void {
  vals.value = {...vals.value, [id]: v};
  saveJSON(KEY, vals.value);
}
