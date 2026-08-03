/**
 * Play setup — the human/CPU split and squad size (tanks per team) reach the match:
 * the first N teams are human, each team fields `tanksPerTeam` tanks that share a
 * colour, and every configured tank spawns. The persisted setup store clamps to the
 * ranges the Play menu offers.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';
import {Roster} from '../src/core/CRoster';
import {setup, setSetup, playersOf, MAX_HUMANS, MAX_TANKS_PER_TEAM} from '../src/ui/setupStore';

describe('Play setup', () => {
  it('human count: the first N teams are human, the rest CPU (1 tank each)', () => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(2);
    gc.setTanksPerTeam(1);
    gc.startGame(4);
    const t = priv(gc).m_tanks;
    expect(t).toHaveLength(4); // four teams → four tanks
    expect(t[0].isHuman() && t[1].isHuman()).toBe(true); // first two are human
    expect(!t[2].isHuman() && !t[3].isHuman()).toBe(true); // the rest are CPU
  });

  it('watch mode: zero humans → every tank is CPU', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(0);
    gc.startGame(2);
    const t = priv(gc).m_tanks;
    expect(!t[0].isHuman() && !t[1].isHuman()).toBe(true); // watch mode has no human
  });

  it("squads: each team fields `tanksPerTeam` tanks sharing that team's colour", () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.setTanksPerTeam(3);
    gc.startGame(2); // 2 teams × 3 tanks = 6
    const t = priv(gc).m_tanks;
    expect(t).toHaveLength(6); // 2 teams × 3 tanks = 6 tanks
    expect(t[0].isHuman() && t[1].isHuman() && t[2].isHuman()).toBe(true); // team 1's squad is human
    expect(!t[3].isHuman() && !t[4].isHuman() && !t[5].isHuman()).toBe(true); // team 2's squad is CPU
    expect(t[0].getTeamId()).toBe(t[2].getTeamId()); // a squad shares one colour/team
    expect(t[0].getTeamId()).not.toBe(t[3].getTeamId()); // the two squads are different teams
    expect(new Set(t.map(x => x.getTeamId())).size).toBe(2); // exactly two teams on the field
  });

  it('every configured tank spawns — no total-tank cap', () => {
    const gc = new CGameController(makeCanvas());
    gc.setTanksPerTeam(5);
    gc.startGame(8);
    expect(priv(gc).m_tanks).toHaveLength(40); // 8 teams × 5 tanks, none dropped

    // The Play menu's own maximum (8 humans + 8 CPUs, 5 tanks each) spawns in full too.
    const big = new CGameController(makeCanvas());
    big.setHumanCount(8);
    big.setTanksPerTeam(5);
    big.startGame(16);
    const bt = priv(big).m_tanks;
    expect(bt).toHaveLength(80);
    // Both roster pools are drawn on in full, so all 16 players get their own colour/team —
    // the palette has exactly 16 entries and the two pools are 8 + 8.
    expect(new Set(bt.map(t => t.getTeamId())).size).toBe(16);
  });

  it('the status overlay is one row per PLAYER, collapsing to the active row past 4', () => {
    // As in the original: up to four sides are listed in full, and from the fifth on only the
    // acting player's row is printed. Rows are per team, so squad size never grows the list —
    // the collapse is a presentation choice the desktop HUD applies to these same rows.
    const gc = new CGameController(makeCanvas());
    for (const [players, per, collapsed] of [
      [2, 1, false],
      [2, 5, false], // a duel stays listed no matter how big the squads are
      [4, 5, false], // four players = four rows, even at 20 tanks on the field
      [5, 1, true], // …the fifth player collapses it, even at one tank each
      [13, 1, true],
      [8, 5, true],
    ] as const) {
      // Keep the split inside the menu's own pools (≤8 humans, ≤8 CPUs) so every player draws a
      // distinct roster colour — i.e. really is its own team.
      gc.setHumanCount(Math.max(1, players - 8));
      gc.setTanksPerTeam(per);
      gc.startGame(players);
      expect(gc.getStatusCompact()).toBe(collapsed);
      expect(gc.getTeamStatuses()).toHaveLength(players); // one row per player, NOT per tank
      expect(gc.getTeamStatuses().filter(s => s.active)).toHaveLength(1); // exactly one acting side
      expect(gc.getTeamStatuses().every(s => s.lifePct === 100 && s.alive)).toBe(true);
      expect(gc.getTeamStatuses().every(s => s.name.length > 0)).toBe(true); // labelled by player
    }
  });

  it("a squad's row averages its members' life, and squad suffixes are dropped", () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.setTanksPerTeam(4);
    gc.startGame(2);
    const tanks = priv(gc).m_tanks;
    const mine = tanks.filter(t => t.getTeamId() === tanks[0].getTeamId());
    expect(mine).toHaveLength(4);

    // Individual tanks are "Name 1".."Name 4"; the team row is the bare player name.
    const row = () => gc.getTeamStatuses().find(s => s.active)!;
    expect(mine.some(t => t.getName() === row().name)).toBe(false); // not any one member's name
    expect(mine[0].getName().startsWith(row().name)).toBe(true); // …but the stem they share

    mine[0].hit(999999); // one of four wiped out
    expect(mine[0].isAlive()).toBe(false);
    expect(row().lifePct).toBe(75); // averaged over the squad, dead member counts as 0
    expect(row().alive).toBe(true); // the side is still in it
  });

  it('the initial (default) setup is always a startable match (≥ 2 players)', () => {
    expect(playersOf(setup.value)).toBeGreaterThanOrEqual(2); // default setup has an opponent
  });

  it('the setup store clamps to the supported ranges', () => {
    setSetup({humans: 99, computers: 99, tanksPerTeam: 99});
    expect(setup.value.humans).toBe(MAX_HUMANS); // humans clamps to max
    expect(setup.value.tanksPerTeam).toBe(MAX_TANKS_PER_TEAM); // tanks clamps to max

    setSetup({humans: -3, computers: -3, tanksPerTeam: -3});
    expect(setup.value.humans).toBe(0); // humans clamps to zero
    expect(setup.value.tanksPerTeam).toBe(1); // tanks clamps to one

    setSetup({humans: 2, computers: 3, tanksPerTeam: 1});
    expect(playersOf(setup.value)).toBe(5); // players = humans + computers

    // A legacy persisted setup ({total, humans}, no computers / tanksPerTeam) must not yield
    // NaN — the missing fields fall back to sensible defaults.
    setSetup({total: 4, humans: 1} as unknown as Parameters<typeof setSetup>[0]);
    expect(Number.isFinite(setup.value.computers) && Number.isFinite(setup.value.tanksPerTeam)).toBe(true); // legacy setup never produces NaN
  });
});
