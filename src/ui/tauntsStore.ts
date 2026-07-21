/**
 * Taunt / speech-bubble message lists.
 *
 * The original ships three loose text files next to the binary — "chat death.txt",
 * "chat post fire.txt", "chat taunt.txt" — each a newline-delimited list of lines a
 * tank can say. A bubble is chosen by picking one line at random from the relevant
 * list (RE: FUN_0046b3d0 → `rand() % count`, with NO weapon/nuke/health weighting;
 * the "glowing / radioactive / melting" lines just live in the death + post-fire
 * lists and surface by the modulo roll). The category is what's contextual:
 *   • death     — the victim's line when its tank is destroyed
 *   • post-fire — the acting tank's gloat as the turn advances after a shot
 *   • taunt     — the idle / manual "Chat Taunt" line
 *
 * In the 2007 game you edited the .txt files to customise these. We can't rewrite
 * files from the browser, so the defaults below (transcribed verbatim from those
 * files) are overridable per-category in localStorage via the Customize Taunts
 * editor. Signal-backed so the editor and the in-game bubbles both react to edits.
 */
import {signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';
import {Taunts, type TauntCategory} from '../core/CTaunts';

export type {TauntCategory};

export const TAUNT_CATEGORIES: {id: TauntCategory; label: string; desc: string}[] = [
  {id: 'taunt', label: 'Taunts', desc: 'Said on a whim during a turn (and on the Chat Taunt key)'},
  {id: 'postFire', label: 'Post-Fire', desc: 'Gloated after a shot, as the turn passes on'},
  {id: 'death', label: 'Death', desc: 'Cried out by a tank as it is destroyed'},
];

// Defaults transcribed verbatim from the original "chat *.txt" files (double
// spaces preserved). These are the fallback; the editor overrides them per list.
const DEFAULTS: Record<TauntCategory, string[]> = {
  death: [
    "I knew I shouldn't have left home today.",
    "I'll be back, muhahhaha!",
    'And I just got a new paint job for this thing :(',
    "That wasn't very nice of you.",
    "Why don't you pick on someone your own size?",
    "The admiral isn't going to be happy about this :(",
    "I'll get you next time, you'll see.",
    'You must of been cheating.',
    'Well at least the radioactive glow will keep me warm :)',
    "Ahhhh, I'm glowing!",
    "I'm melting, melting...",
    "It's the tanks fault I lost, stupid tank, time for a new one.",
  ],
  postFire: [
    'Clean up in aisle four.',
    'Was that a blast from the past?',
    "That's gonna leave a mark.",
    "If you beg for mercy I'll go easy on you on next time.",
    'So many weapons and such little time.',
    'What color would you like to glow next round?',
    "You can run but you can't hide.",
    "You're making this win easy.",
    "Just give up, it's only a matter of time before I win.",
    'Does your pretty tank have a scratch on it now?',
    "Why don't you just die already?",
    "That's right!",
  ],
  taunt: [
    "Is that all you've got?",
    'You can do better than that!',
    "You're going to lose this one.",
    'Who ordered the NUKE?',
    'Which weapon shall I destroy you with this time?',
    'Your aim is as weak as your armor!',
    "Surrender now and you won't face humiliation.",
    "You're going down!",
    "Why don't you just save us both some time and blow yourself up?",
    'You will be exterminated.',
    'That radioactive glow looks good on you!',
    "You should save your credits and just buy a win, because it won't happen with skill ;)",
    'I taunt you a second time!',
    'Your mother wears combat boots :p',
    'Any weapon requests?  I own them all.',
    "What's taking so long?  Searching for the self destruct button again?",
    'Resistance is futile!',
  ],
};

const KEY = 'atomic.taunts';

/** Only the lists the player has edited are stored; the rest fall back to DEFAULTS. */
type Overrides = Partial<Record<TauntCategory, string[]>>;

const overrides = signal<Overrides>(loadJSON<Overrides>(KEY, {}));

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
  return overrides.value[cat] ?? DEFAULTS[cat];
}

/** The verbatim shipped defaults (for the "Reset to defaults" action). */
export function defaultTaunts(cat: TauntCategory): string[] {
  return DEFAULTS[cat].slice();
}

/** Replace a category's list (the raw editor draft — blanks are kept for editing but
 *  filtered before they reach gameplay). Persisted + pushed to the engine at once. */
export function setTauntLines(cat: TauntCategory, lines: string[]): void {
  overrides.value = {...overrides.value, [cat]: lines};
  saveJSON(KEY, overrides.value);
  pushToEngine(cat);
}

/** Drop a category's override so it reverts to the shipped defaults. */
export function resetTauntLines(cat: TauntCategory): void {
  const next = {...overrides.value};
  delete next[cat];
  overrides.value = next;
  saveJSON(KEY, next);
  pushToEngine(cat);
}

/** Whether a category currently differs from the shipped defaults. */
export function tauntsEdited(cat: TauntCategory): boolean {
  return overrides.value[cat] !== undefined;
}
