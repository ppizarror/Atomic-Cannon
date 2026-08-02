/**
 * Randomize Position (Gameplay): tanks are pushed squad by squad, so by default each player's
 * squad lands as one contiguous block on the map. With the option ON the spawn SLOTS are shuffled,
 * scattering squads across the field. Only the index→slot mapping changes — the turn queue, teams
 * and snapshot indices are untouched.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {sanitizeMatchConfig} from '../src/net/protocol';

const tanksOf = (gc: CGameController) => priv(gc).m_tanks;

/** 4 players × 4 tanks, spawned with the option in whatever state the caller set. */
function match(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.setTanksPerTeam(4);
  gc.startGame(4);
  return gc;
}

/** The teams in left-to-right map order — the shape the option is about. */
const teamsByPosition = (gc: CGameController): number[] =>
  tanksOf(gc)
    .slice()
    .sort((a, b) => a.getPosition().x - b.getPosition().x)
    .map(t => t.getTeamId());

/** Longest run of one team among left-to-right neighbours (4 = a fully contiguous squad). */
function longestRun(teams: number[]): number {
  let best = 1,
    run = 1;
  for (let i = 1; i < teams.length; i++) {
    run = teams[i] === teams[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/** A host MatchConfig at the protocol defaults — only randomizePosition matters here. */
const HOST_CFG = sanitizeMatchConfig();

const dflt = GameConfig.randomizePosition;
afterEach(() => {
  GameConfig.randomizePosition = dflt;
});

describe('Randomize Position', () => {
  it('is ON by default — the original always shuffled tanks across the spawn bands', () => {
    expect(dflt).toBe(true);
  });

  it('OFF: each squad lands as one contiguous block', () => {
    GameConfig.randomizePosition = false;
    const gc = match();
    const teams = teamsByPosition(gc);
    expect(teams).toHaveLength(16);
    // Every squad occupies four adjacent spawn slots: A A A A B B B B …
    expect(longestRun(teams)).toBe(4);
    expect(new Set(teams).size).toBe(4);
  });

  it('ON: squads are scattered instead of grouped', () => {
    GameConfig.randomizePosition = true;
    // The shuffle is seeded, so a single match could in principle come back grouped by chance.
    // Across several matches at least one must break the blocks — a no-op implementation could not.
    const runs = [];
    for (let i = 0; i < 8; i++) runs.push(longestRun(teamsByPosition(match())));
    expect(Math.min(...runs)).toBeLessThan(4);
  });

  it('ON: only WHERE tanks stand changes — the turn queue and teams are untouched', () => {
    GameConfig.randomizePosition = false;
    const plain = match();
    GameConfig.randomizePosition = true;
    const shuffled = match();

    // The array order IS the turn queue and the snapshot index space: it must still run squad by
    // squad, with each tank keeping its own name/team, whatever the map layout.
    expect(tanksOf(shuffled).map(t => t.getTeamId())).toEqual(
      tanksOf(plain).map(t => t.getTeamId()),
    );
    expect(tanksOf(shuffled).map(t => t.getName())).toEqual(tanksOf(plain).map(t => t.getName()));
    // Same set of spawn slots either way — the option permutes them, it doesn't invent positions
    // (so tanks stay evenly spread and never pile up).
    expect(tanksOf(shuffled)).toHaveLength(tanksOf(plain).length);
  });

  it('net: every client lands on the HOST’s scatter, not its own setting', () => {
    // Spawn X is sim-critical, so the option rides the shared MatchConfig and the shuffle draws
    // from the SEEDED match RNG (unlike Randomize Turns, which uses Math.random and is forced off
    // in net play). Two clients on the same seed must therefore build the same battlefield.
    const client = (localIndex: number, localSetting: boolean) => {
      GameConfig.randomizePosition = localSetting; // whatever THIS client had locally
      const gc = new CGameController(makeCanvas());
      gc.startNetworkGame({
        seed: 4242,
        players: 4,
        localIndex,
        roster: [
          {name: 'Ada', color: '#f00'},
          {name: 'Bo', color: '#0f0'},
          {name: 'Cy', color: '#00f'},
          {name: 'Di', color: '#ff0'},
        ],
        wind: 1,
        mapSize: 2,
        battles: 2,
        tanksPerTeam: 4,
        currentBattle: 1,
        viewW: 1280,
        viewH: 720,
        config: {...HOST_CFG, randomizePosition: true},
      });
      return gc;
    };
    const a = client(0, false); // this player had it OFF locally…
    const b = client(1, true); // …this one ON — the host's value must win on both
    const xs = (gc: CGameController) => tanksOf(gc).map(t => Math.round(t.getPosition().x));
    expect(xs(a)).toEqual(xs(b));
    expect(GameConfig.randomizePosition).toBe(true); // the host's setting was adopted
    expect(longestRun(teamsByPosition(a))).toBeLessThan(4); // and it really did scatter
  });
});
