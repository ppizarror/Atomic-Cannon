/**
 * Persisted key bindings — the map the "Customize Controls" editor edits and the
 * gameplay input loop reads. Stored in its own localStorage slot (separate from the
 * general settings), signal-backed so the editor re-renders as rows are rebound.
 * A missing/corrupt store falls back to the factory defaults.
 */
import {type ActionId, type Bindings, defaultBindings} from '../core/CControls';
import {createPersistedSignal} from './persistedSignal';

const KEY = 'atomic.controls';

const store = createPersistedSignal<Bindings>(KEY, {
  // Merge stored codes over the defaults so a file that predates a new action still works.
  revive: raw => {
    const base = defaultBindings();
    const saved = raw as Partial<Bindings>;
    for (const id of Object.keys(base) as ActionId[]) {
      if (typeof saved[id] === 'string') base[id] = saved[id] as string;
    }
    return base;
  },
  seed: defaultBindings,
});

export const bindings = store.signal;

/** Bind `code` to `id`; if another action already held `code`, it is unassigned
 *  (a key drives one action at a time — matching the editor's guided sweep). */
export function rebind(id: ActionId, code: string): void {
  const b = {...bindings.value};
  for (const key of Object.keys(b) as ActionId[]) {
    if (b[key] === code) b[key] = '';
  }
  b[id] = code;
  store.set(b);
}

export function unassign(id: ActionId): void {
  store.set({...bindings.value, [id]: ''});
}

export function resetDefaults(): void {
  store.set(defaultBindings());
}
