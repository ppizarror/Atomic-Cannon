/**
 * A localStorage-backed signal — the shape every persisted store repeated: seed a signal
 * from the stored value on init, and re-persist on every change. The content/controls/players/
 * setup stores pass only the parts that actually differ rather than each hand-writing its own
 * `load()` + `persist()` pair.
 *
 * `revive` turns the stored (parsed JSON) shape into the live value; `seed` is the
 * fresh / absent / corrupt default; `encode` turns the live value back into something
 * storable (identity by default — e.g. a `Set` uses `[...s]`). `storage.ts` already swallows
 * quota / private-mode / parse errors, and a `revive` that throws on a malformed value also
 * falls back to `seed`.
 */
import {signal, type Signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';

export interface PersistedSignal<T> {
  /** The reactive value — read in components / the engine bridge. */
  signal: Signal<T>;
  /** Assign + persist. Mutators compute the next value and call this. */
  set(next: T): void;
}

export function createPersistedSignal<T>(
  key: string,
  opts: {revive: (raw: unknown) => T; seed: () => T; encode?: (v: T) => unknown},
): PersistedSignal<T> {
  const {revive, seed, encode} = opts;
  const stored = loadJSON<unknown>(key, null);
  let initial: T;
  try {
    initial = stored === null ? seed() : revive(stored);
  } catch {
    initial = seed(); // malformed stored value → fall back to the default
  }
  const sig = signal<T>(initial);
  return {
    signal: sig,
    set(next: T): void {
      sig.value = next;
      saveJSON(key, encode ? encode(next) : next);
    },
  };
}
