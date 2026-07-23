/**
 * Persisted key bindings — the map the "Customize Controls" editor edits and the
 * gameplay input loop reads. Stored in its own localStorage slot (separate from the
 * general settings), signal-backed so the editor re-renders as rows are rebound.
 * A missing/corrupt store falls back to the factory defaults.
 */
import {signal} from '@preact/signals';
import {type ActionId, type Bindings, defaultBindings} from '../core/CControls';
import {loadJSON, saveJSON} from '../util/storage';

const KEY = 'atomic.controls';

function load(): Bindings {
  const base = defaultBindings();
  const saved = loadJSON<Partial<Bindings>>(KEY, {});
  // Merge over defaults so a stored file that predates a new action still works.
  for (const id of Object.keys(base) as ActionId[]) {
    if (typeof saved[id] === 'string') base[id] = saved[id] as string;
  }
  return base;
}

function persist(b: Bindings): void {
  saveJSON(KEY, b);
}

export const bindings = signal<Bindings>(load());

/** Bind `code` to `id`; if another action already held `code`, it is unassigned
 *  (a key drives one action at a time — matching the editor's guided sweep). */
export function rebind(id: ActionId, code: string): void {
  const b = {...bindings.value};
  for (const key of Object.keys(b) as ActionId[]) {
    if (b[key] === code) b[key] = '';
  }
  b[id] = code;
  bindings.value = b;
  persist(b);
}

export function unassign(id: ActionId): void {
  const b = {...bindings.value, [id]: ''};
  bindings.value = b;
  persist(b);
}

export function resetDefaults(): void {
  const b = defaultBindings();
  bindings.value = b;
  persist(b);
}
