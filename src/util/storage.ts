/**
 * Tiny localStorage JSON helpers. Both the settings store and the audio settings
 * hand-rolled the same get→JSON.parse→try/catch and stringify→setItem→try/catch;
 * this is the one place that swallows the private-mode / quota / corrupt-value cases.
 *
 * It is also the single choke point every persisted store already writes through, which is what
 * `onStorageWrite` exploits: profile sync learns that something changed without any store having
 * to announce it, so a store added later is covered automatically (the same trick
 * `settingsBackup` plays by snapshotting the whole `atomic.` namespace).
 */

/** Notified with the key of every value successfully written. */
type WriteListener = (key: string) => void;

const writeListeners = new Set<WriteListener>();

/**
 * Subscribe to every successful {@link saveJSON}; returns an unsubscribe.
 *
 * Only WRITES notify — {@link removeKey} stays silent on purpose. Its only callers wipe or
 * wholesale-replace the namespace and then reload the page, so firing per removed key would
 * announce a torrent of "changes" describing a state that is about to cease to exist.
 */
export function onStorageWrite(fn: WriteListener): () => void {
  writeListeners.add(fn);
  return () => void writeListeners.delete(fn);
}

/** Read + JSON-parse a localStorage key, returning `dflt` if it's missing, corrupt,
 *  or storage is unavailable (e.g. private mode). */
export function loadJSON<T>(key: string, dflt: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : dflt;
  } catch {
    return dflt;
  }
}

/** JSON-stringify `val` and persist it under `key`. No-op if storage is unavailable —
 *  the value still applies for the current session. */
export function saveJSON(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    return; // storage unavailable (private mode / quota) — nothing persisted, so nothing changed
  }
  // A listener must never be able to break a store's write, so failures are contained here.
  for (const fn of writeListeners) {
    try {
      fn(key);
    } catch {
      /* a subscriber's problem is not the writer's */
    }
  }
}

/** Delete a key. Silent by design — see {@link onStorageWrite}. */
export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing persisted to remove */
  }
}
