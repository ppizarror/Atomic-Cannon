/**
 * Persisted player roster — the per-player name / tank model / colour edited in the
 * "Customize Players" screen. Signal-backed so the editor re-renders on change, and
 * applied to the match at the next `startGame`. Colour is the player's identity:
 * tanks sharing a colour form a team, so the colour choice is what decides sides.
 * Each player defaults to a distinct colour from the 16-entry palette (a fresh match
 * is therefore every-player-for-themselves until players pick matching colours).
 */
import {signal} from '@preact/signals';
import {PLAYER_TANKS, TEAM_COLORS} from '../core/CTank';
import type {PlayerCfg} from '../core/CRoster';

export type {PlayerCfg};

/** Roster capacity — the palette has 16 distinct colours, so up to 16 players. */
export const MAX_PLAYERS = 16;

const KEY = 'atomic.players';

// Default bot names (player 0 is "Player"); cycled if the roster runs past the list.
const BOT_NAMES = [
  'Whopper',
  'BrainBot',
  'RandBot',
  'AlphaBot',
  'MechaBot',
  'FlashBot',
  'GammaBot',
  'ShazBot',
  'BetaBot',
  'DeltaBot',
];

function defaultPlayer(i: number): PlayerCfg {
  return {
    name: i === 0 ? 'Player' : BOT_NAMES[(i - 1) % BOT_NAMES.length],
    model: PLAYER_TANKS[i % PLAYER_TANKS.length],
    color: TEAM_COLORS[i] ?? '#0000ff',
  };
}

function defaultRoster(): PlayerCfg[] {
  return Array.from({length: MAX_PLAYERS}, (_, i) => defaultPlayer(i));
}

function load(): PlayerCfg[] {
  const base = defaultRoster();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PlayerCfg>[];
      for (let i = 0; i < base.length; i++) {
        const s = saved[i];
        if (!s) continue;
        if (typeof s.name === 'string') base[i].name = s.name;
        if (typeof s.model === 'string') base[i].model = s.model;
        if (typeof s.color === 'string') base[i].color = s.color;
      }
    }
  } catch {
    /* corrupt/absent — the defaults stand */
  }
  return base;
}

function persist(r: PlayerCfg[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable — the roster still applies this session */
  }
}

export const roster = signal<PlayerCfg[]>(load());

function update(i: number, patch: Partial<PlayerCfg>): void {
  if (i < 0 || i >= roster.value.length) return;
  const next = roster.value.map((p, idx) => (idx === i ? {...p, ...patch} : p));
  roster.value = next;
  persist(next);
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
