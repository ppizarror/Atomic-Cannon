/**
 * Import / Export / Reset for every persisted game setting.
 *
 * Each store persists under an `atomic.` localStorage key (settings, controls, players,
 * taunts, content, setup, audio, locale, high scores, net name). Rather than couple to each
 * store, these helpers snapshot / restore / clear the whole `atomic.` namespace at the
 * storage layer — a new store is covered automatically as long as it keeps the prefix.
 *
 * Import and Reset rewrite storage underneath the running signals (which seeded at load), so
 * the caller reloads the page afterwards to re-seed every store from the new storage.
 */
import {loadJSON, saveJSON} from './storage';

const PREFIX = 'atomic.';
/** Marker so Import can reject arbitrary JSON files that aren't our backups. */
const FORMAT = 'atomic-cannon-settings';

export interface SettingsBackup {
  format: string;
  version: number;
  /** One entry per `atomic.` key → its parsed JSON value. */
  data: Record<string, unknown>;
}

/** Every `atomic.` key currently in localStorage. [] if storage is unavailable. */
function atomicKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    /* storage unavailable (private mode) */
  }
  return keys;
}

/** Snapshot every `atomic.` key into a portable backup object. */
export function exportSettings(): SettingsBackup {
  const data: Record<string, unknown> = {};
  // Values always round-trip as JSON (all stores write via saveJSON); loadJSON yields null
  // for a value that's somehow corrupt, which serializes back harmlessly.
  for (const key of atomicKeys()) data[key] = loadJSON<unknown>(key, null);
  return {format: FORMAT, version: 1, data};
}

/** Restore a backup produced by {@link exportSettings}. Returns the number of keys written,
 *  or -1 if the text isn't a valid backup. Caller should reload to re-seed the stores. */
export function importSettings(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return -1;
  }
  if (!parsed || typeof parsed !== 'object') return -1;
  const backup = parsed as Partial<SettingsBackup>;
  if (backup.format !== FORMAT || !backup.data || typeof backup.data !== 'object') return -1;
  let count = 0;
  for (const [key, val] of Object.entries(backup.data)) {
    if (!key.startsWith(PREFIX)) continue; // ignore foreign keys defensively
    saveJSON(key, val);
    count++;
  }
  return count;
}

/** Remove every `atomic.` key — a clean-slate reset. Caller should reload afterwards. */
export function resetAllSettings(): void {
  try {
    for (const key of atomicKeys()) localStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing persisted to clear */
  }
}
