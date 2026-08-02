/**
 * Taunt / speech-bubble message lists.
 *
 * The original ships three loose text files — "chat death.txt", "chat post fire.txt",
 * "chat taunt.txt" — each a newline-delimited list of lines a tank can say. A bubble is
 * chosen by picking one line at random from the relevant list (`rand() % count`, with no
 * weapon/nuke/health weighting; the "glowing / radioactive / melting" lines just live in
 * the death + post-fire lists and surface by the modulo roll). The category is what's
 * contextual:
 *   • death     — the victim's line when its tank is destroyed
 *   • post-fire — the acting tank's gloat as the turn advances after a shot
 *   • taunt     — the idle / manual "Chat Taunt" line
 *
 * In the original you edited the .txt files to customise these. We can't rewrite files
 * from the browser, so the defaults below (the original lists) are overridable
 * per-category in localStorage via the Customize Taunts editor. Signal-backed so the
 * editor and the in-game bubbles both react to edits.
 */
import {createPersistedSignal} from './persistedSignal';
import {strings} from '../i18n';
import {Taunts, type TauntCategory} from '../core/CTaunts';

export type {TauntCategory};

/** Editor tab order + copy (label/description), sourced from i18n. */
export const TAUNT_CATEGORIES = (): {id: TauntCategory; label: string; desc: string}[] => {
  const c = strings.value.editors.taunts.categories;
  return [
    {id: 'taunt', label: c.taunt.label, desc: c.taunt.sub},
    {id: 'postFire', label: c.postFire.label, desc: c.postFire.sub},
    {id: 'death', label: c.death.label, desc: c.death.sub},
  ];
};

// Shipped default lines (the original "chat *.txt" content) live in i18n so they are
// translatable; this is the fallback the editor overrides per list.
const DEFAULTS = (cat: TauntCategory): string[] => strings.value.taunts[cat].slice();

const KEY = 'atomic.taunts';

/** Only the lists the player has edited are stored; the rest fall back to DEFAULTS. */
type Overrides = Partial<Record<TauntCategory, string[]>>;

/** Keep only well-formed overrides: each category must be an ARRAY of strings. `loadJSON` guards the
 *  parse, not the shape — a corrupt or foreign `atomic.taunts` value (a category mapped to a
 *  non-array) would otherwise throw in `pushToEngine`'s `.map` at module load and take down boot.
 *  Mirrors the shape-guarding the highscores / players stores already do. */
function sanitize(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const cat of ['death', 'postFire', 'taunt'] as TauntCategory[]) {
    const v = (raw as Record<string, unknown>)[cat];
    if (Array.isArray(v)) out[cat] = v.filter((l): l is string => typeof l === 'string');
  }
  return out;
}

const store = createPersistedSignal<Overrides>(KEY, {revive: sanitize, seed: () => ({})});
const overrides = store.signal;

/** Push a category's gameplay-ready lines (trimmed, no blanks) into the engine's live
 *  pool. Blank lines are allowed in the editor draft but never reach a bubble. */
function pushToEngine(cat: TauntCategory): void {
  Taunts[cat] = tauntLines(cat)
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/** Seed the engine with every list at module load, so bubbles work from the first
 *  turn even before the settings menu (or applyGameSettings) is touched. */
(['death', 'postFire', 'taunt'] as TauntCategory[]).forEach(pushToEngine);

/** The effective (edited-or-default) lines for a category — the raw editor draft
 *  (may include a blank line being typed). */
export function tauntLines(cat: TauntCategory): string[] {
  return overrides.value[cat] ?? DEFAULTS(cat);
}

/** Replace a category's list (the raw editor draft — blanks are kept for editing but
 *  filtered before they reach gameplay). Persisted + pushed to the engine at once. */
export function setTauntLines(cat: TauntCategory, lines: string[]): void {
  store.set({...overrides.value, [cat]: lines});
  pushToEngine(cat);
}

/** Drop a category's override so it reverts to the shipped defaults. */
export function resetTauntLines(cat: TauntCategory): void {
  const next = {...overrides.value};
  delete next[cat];
  store.set(next);
  pushToEngine(cat);
}

/** Whether a category currently differs from the shipped defaults. */
export function tauntsEdited(cat: TauntCategory): boolean {
  return overrides.value[cat] !== undefined;
}
