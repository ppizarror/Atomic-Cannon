/**
 * Persisted option values for the Settings tree.
 *
 * Each option lives in a single flat map (keyed by a stable id) persisted to
 * localStorage. Options that drive live
 * subsystems — Audio (CAudio) and Difficulty (the controller) — are NOT stored here;
 * their widgets bind straight to those subsystems so the menu reflects the real state
 * and there's one source of truth. Everything else is a preference we remember.
 */
import { signal } from '@preact/signals';

const KEY = 'atomic.settings';

type Vals = Record<string, number>;

function load(): Vals {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Vals) : {};
  } catch {
    return {};
  }
}

// Signal-backed so widgets that read it re-render on change.
const vals = signal<Vals>(load());

/** Current value for `id`, or `dflt` if never set. */
export function getVal(id: string, dflt: number): number {
  const v = vals.value[id];
  return v === undefined ? dflt : v;
}

/** Set `id` and persist the whole map. */
export function setVal(id: string, v: number): void {
  vals.value = { ...vals.value, [id]: v };
  try {
    localStorage.setItem(KEY, JSON.stringify(vals.value));
  } catch {
    /* storage unavailable (private mode) — the value still applies this session */
  }
}
