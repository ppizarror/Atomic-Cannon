/**
 * Persisted option values for the Settings tree.
 *
 * Every option lives in a single flat map keyed by a stable {@link SettingId} and
 * persisted to localStorage. Each id and its default come from {@link SETTINGS}
 * (settingsCatalog) — the one source both the widgets and the engine-facing getters read.
 * Audio (Sound / Music / volumes) is the only exception: those widgets bind straight to
 * CAudio so the menu reflects the live state, so they aren't stored here.
 */
import {signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';
import {SETTINGS, type SettingId} from './settingsCatalog';

const KEY = 'atomic.settings';

type Vals = Partial<Record<SettingId, number>>;

// Signal-backed so widgets that read it re-render on change.
const vals = signal<Vals>(loadJSON<Vals>(KEY, {}));

/** Current value for `id`, or its catalog default if never set. */
export function getVal(id: SettingId): number {
  const v = vals.value[id];
  return v === undefined ? SETTINGS[id].default : v;
}

/** Set `id` and persist the whole map. */
export function setVal(id: SettingId, v: number): void {
  vals.value = {...vals.value, [id]: v};
  saveJSON(KEY, vals.value);
}
