/**
 * Persisted game setup — how many players the next match has and how many of them are
 * human (the first N tanks; the rest are CPU). Written by the Play setup screen and
 * replayed by Quick Play ("play with your last config"). Total draws its per-player
 * name / colour / tank from the Customize Players roster.
 */
import {signal} from '@preact/signals';
import {MAX_PLAYERS} from './playersStore';

const KEY = 'atomic.setup';

/** A match needs at least two tanks; the roster caps the upper end. */
export const MIN_TANKS = 2;
export const MAX_TANKS = MAX_PLAYERS;

export interface Setup {
  /** Total tanks in the match (humans + CPU). */
  total: number;
  /** How many of them are human (the first `humans` tanks). */
  humans: number;
}

const clampSetup = (s: Setup): Setup => {
  const total = Math.min(MAX_TANKS, Math.max(MIN_TANKS, Math.round(s.total)));
  const humans = Math.min(total, Math.max(0, Math.round(s.humans)));
  return {total, humans};
};

function load(): Setup {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return clampSetup(JSON.parse(raw) as Setup);
  } catch {
    /* corrupt/absent — fall through to the default (Quick Start: 1 human + 1 CPU) */
  }
  return {total: 2, humans: 1};
}

function persist(s: Setup): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — the setup still applies this session */
  }
}

export const setup = signal<Setup>(load());

/** Set + persist the setup (clamped). Used by presets and the steppers. */
export function setSetup(next: Setup): void {
  const s = clampSetup(next);
  setup.value = s;
  persist(s);
}

/** cpu = total − humans. */
export const cpuOf = (s: Setup): number => s.total - s.humans;
