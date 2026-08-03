/**
 * Persisted game setup — the Play menu's match configuration: how many human and
 * computer players, and the squad size (tanks per player's team). Written by the Play
 * screen and replayed by Quick Play ("play with your last config"). Per-player name /
 * colour / tank come from the Customize Players roster; the shared match options
 * (Game Type / Battles / Rounds / Land Size / Difficulty / Wind) live in settingsStore.
 */
import {createPersistedSignal} from './persistedSignal';
import {clamp} from '../math/num';
import {ROSTER_HUMAN_SLOTS} from '../core/CRoster';

const KEY = 'atomic.setup';

// A startable match needs at least two teams (an opponent). Fresh, and whenever a
// stored setup falls short, we land on 1 human + 1 CPU.
const DEFAULT_SETUP: Setup = {humans: 1, computers: 1, tanksPerTeam: 1};
const MIN_PLAYERS = 2;

// Ranges from the original's Play page (Humans/Computers 0..8, Tanks 1..5). The human/computer
// caps ARE the roster's two pools (slots 0..7 human, 8..15 bot), so they share one source of truth.
export const MAX_HUMANS = ROSTER_HUMAN_SLOTS;
export const MAX_COMPUTERS = 8;
export const MIN_TANKS_PER_TEAM = 1;
export const MAX_TANKS_PER_TEAM = 5;

export interface Setup {
  humans: number;
  computers: number;
  /** Tanks each player fields — squad size. */
  tanksPerTeam: number;
}

// Clamp one count, falling back to `dflt` for missing/NaN values so a stored setup
// from an older schema (or any bad input) never yields NaN.
const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, min, max) : dflt;
};

const clampSetup = (s: Partial<Setup>): Setup => ({
  humans: clampInt(s.humans, 0, MAX_HUMANS, 1),
  computers: clampInt(s.computers, 0, MAX_COMPUTERS, 1),
  tanksPerTeam: clampInt(s.tanksPerTeam, MIN_TANKS_PER_TEAM, MAX_TANKS_PER_TEAM, 1),
});

const store = createPersistedSignal<Setup>(KEY, {
  // Heal an unstartable stored setup (e.g. 1 human + 0 CPU) so the initial view is a valid match.
  revive: raw => {
    const s = clampSetup(raw as Partial<Setup>);
    return s.humans + s.computers >= MIN_PLAYERS ? s : {...DEFAULT_SETUP, tanksPerTeam: s.tanksPerTeam};
  },
  seed: () => ({...DEFAULT_SETUP}),
});

export const setup = store.signal;

/** Set + persist the setup (clamped). */
export function setSetup(next: Setup): void {
  store.set(clampSetup(next));
}

/** Number of players (teams) = humans + computers. */
export const playersOf = (s: Setup): number => s.humans + s.computers;
