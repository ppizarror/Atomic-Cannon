/**
 * Tiny localStorage JSON helpers. Both the settings store and the audio settings
 * hand-rolled the same get→JSON.parse→try/catch and stringify→setItem→try/catch;
 * this is the one place that swallows the private-mode / quota / corrupt-value cases.
 */

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
        /* storage unavailable (private mode / quota) — nothing else to do */
    }
}
