/**
 * Battle Heroes — the hall of fame behind the "High Scores" menu item. Two Top-10
 * boards (Score for Points/Rounds games, Kills for Deathmatch), plus the local
 * player's cumulative battles won / lost (which drives the medal footer).
 *
 * The original keeps all of this in memory only — wiped on relaunch. This web port
 * persists it to localStorage (the one deliberate enhancement) so a leaderboard that
 * would otherwise vanish on every refresh actually accumulates.
 */
import {signal} from '@preact/signals';
import {loadJSON, saveJSON} from '../util/storage';
import type {BattleHeroTeam} from '../game/CGameController';

const KEY = 'atomic.heroes';
const CAP = 10; // Top 10 boards (legacy cap)
const NAME_MAX = 31; // legacy callsign length (strncpy 0x1f)

/** One hall-of-fame row: a callsign and its board value (score or kills). */
export interface HeroEntry {
  name: string;
  value: number;
}

interface HeroData {
  score: HeroEntry[]; // Points/Rounds board (average damage per tank)
  kills: HeroEntry[]; // Deathmatch board (team total kills)
  won: number; // local player's battles won (all-time, this device)
  lost: number; // local player's battles lost
}

const cleanList = (v: unknown): HeroEntry[] =>
  Array.isArray(v)
    ? v
        .filter(
          (e): e is HeroEntry => !!e && typeof e.name === 'string' && Number.isFinite(e.value),
        )
        .map(e => ({name: String(e.name).slice(0, NAME_MAX), value: Math.round(e.value)}))
        .sort((a, b) => b.value - a.value)
        .slice(0, CAP)
    : [];

const cleanCount = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function load(): HeroData {
  const raw = loadJSON<Partial<HeroData> | null>(KEY, null);
  return {
    score: cleanList(raw?.score),
    kills: cleanList(raw?.kills),
    won: cleanCount(raw?.won),
    lost: cleanCount(raw?.lost),
  };
}

/** The whole hall of fame, reactive. Components read `heroData.value`. */
export const heroData = signal<HeroData>(load());

function persist(d: HeroData): void {
  heroData.value = d;
  saveJSON(KEY, d);
}

// Insert into a board, keeping it sorted descending and capped at CAP. An equal new
// value lands ABOVE existing equals (legacy scan stops at the first entry <= it).
function insert(list: HeroEntry[], e: HeroEntry): HeroEntry[] {
  const i = list.findIndex(x => x.value <= e.value);
  const next = i < 0 ? [...list, e] : [...list.slice(0, i), e, ...list.slice(i)];
  return next.slice(0, CAP);
}

/**
 * Submit one war's teams to the boards (called at war end). Each team lands on the
 * Score board (average damage) and the Kills board, mirroring the original which
 * populates both regardless of game type; a zero value is skipped so the boards don't
 * fill with blanks.
 */
export function submitBattleHeroes(teams: BattleHeroTeam[]): void {
  const d = heroData.value;
  let {score, kills} = d;
  for (const t of teams) {
    const name = t.name.slice(0, NAME_MAX);
    if (t.score > 0) score = insert(score, {name, value: t.score});
    if (t.kills > 0) kills = insert(kills, {name, value: t.kills});
  }
  persist({...d, score, kills});
}

/** Advance the local player's battles won / lost tally (one battle end). */
export function recordBattleOutcome(won: boolean): void {
  const d = heroData.value;
  persist(won ? {...d, won: d.won + 1} : {...d, lost: d.lost + 1});
}
