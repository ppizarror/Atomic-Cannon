/**
 * Persisted player roster — the per-player name / tank model / colour edited in the
 * "Customize Players" screen. Signal-backed so the editor re-renders on change, and
 * applied to the match at the next `startGame`. Colour is the player's identity:
 * tanks sharing a colour form a team, so the colour choice is what decides sides.
 * Each player defaults to a distinct colour from the 16-entry palette (a fresh match
 * is therefore every-player-for-themselves until players pick matching colours).
 */
import {PLAYER_TANKS, TEAM_COLORS, DEFAULT_TEAM_COLOR} from '../core/CTank';
import type {PlayerCfg} from '../core/CRoster';
import {ROSTER_HUMAN_SLOTS} from '../core/CRoster';
import {strings} from '../i18n';
import {createPersistedSignal} from './persistedSignal';

export type {PlayerCfg};

/** Roster capacity — the palette has 16 distinct colours, so up to 16 players. */
export const MAX_PLAYERS = 16;

const KEY = 'atomic.players';

// Default names come from i18n, split by the roster's two pools (see ROSTER_HUMAN_SLOTS): the human
// slots (0..7) cycle the human name pool (player 0 is the localised "Player"); the bot slots (8..15)
// cycle the "…Bot" pool (AlphaBot, MechaBot, …), matching how the original names CPU opponents. Both
// repeat if a pool runs short. These seed a fresh roster only; an edited/persisted name is verbatim.
function defaultPlayer(i: number): PlayerCfg {
  const bot = i >= ROSTER_HUMAN_SLOTS;
  const botNames = strings.value.botNames;
  const humanNames = strings.value.playerNames;
  const name = bot
    ? botNames[(i - ROSTER_HUMAN_SLOTS) % botNames.length]
    : i === 0
      ? strings.value.game.defaultPlayer
      : humanNames[(i - 1) % humanNames.length];
  return {
    name,
    model: PLAYER_TANKS[i % PLAYER_TANKS.length],
    color: TEAM_COLORS[i] ?? DEFAULT_TEAM_COLOR,
  };
}

function defaultRoster(): PlayerCfg[] {
  return Array.from({length: MAX_PLAYERS}, (_, i) => defaultPlayer(i));
}

const store = createPersistedSignal<PlayerCfg[]>(KEY, {
  // Merge stored per-field values over the default roster (tolerates a short/old file).
  revive: raw => {
    const base = defaultRoster();
    const saved = raw as Partial<PlayerCfg>[];
    for (let i = 0; i < base.length; i++) {
      const s = saved[i];
      if (!s) continue;
      if (typeof s.name === 'string') base[i].name = s.name;
      if (typeof s.model === 'string') base[i].model = s.model;
      if (typeof s.color === 'string') base[i].color = s.color;
    }
    return base;
  },
  seed: defaultRoster,
});

export const roster = store.signal;

function update(i: number, patch: Partial<PlayerCfg>): void {
  if (i < 0 || i >= roster.value.length) return;
  store.set(roster.value.map((p, idx) => (idx === i ? {...p, ...patch} : p)));
}

export const setName = (i: number, name: string): void => update(i, {name});
export const setModel = (i: number, model: string): void => update(i, {model});
export const setColor = (i: number, color: string): void => update(i, {color});

/** Cycle player `i`'s tank model forward (+1) or back (−1) through PLAYER_TANKS. */
export function cycleModel(i: number, dir: number): void {
  const cur = Math.max(0, PLAYER_TANKS.indexOf(roster.value[i]?.model ?? ''));
  const n = (cur + dir + PLAYER_TANKS.length) % PLAYER_TANKS.length;
  setModel(i, PLAYER_TANKS[n]);
}
