/**
 * Play setup — the human/CPU split and squad size (tanks per team) reach the match:
 * the first N teams are human, each team fields `tanksPerTeam` tanks that share a
 * colour, total capped at 16. The persisted setup store clamps to the binary ranges.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';
import {setup, setSetup, playersOf, MAX_HUMANS, MAX_TANKS_PER_TEAM} from '../src/ui/setupStore';

type Tanks = {m_tanks: CTank[]};

describe('Play setup', () => {
  it('human count: the first N teams are human, the rest CPU (1 tank each)', () => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(2);
    gc.setTanksPerTeam(1);
    gc.startGame(4);
    const t = (gc as unknown as Tanks).m_tanks;
    expect(t).toHaveLength(4); // four teams → four tanks
    expect(t[0].isHuman() && t[1].isHuman()).toBe(true); // first two are human
    expect(!t[2].isHuman() && !t[3].isHuman()).toBe(true); // the rest are CPU
  });

  it('watch mode: zero humans → every tank is CPU', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(0);
    gc.startGame(2);
    const t = (gc as unknown as Tanks).m_tanks;
    expect(!t[0].isHuman() && !t[1].isHuman()).toBe(true); // watch mode has no human
  });

  it("squads: each team fields `tanksPerTeam` tanks sharing that team's colour", () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.setTanksPerTeam(3);
    gc.startGame(2); // 2 teams × 3 tanks = 6
    const t = (gc as unknown as Tanks).m_tanks;
    expect(t).toHaveLength(6); // 2 teams × 3 tanks = 6 tanks
    expect(t[0].isHuman() && t[1].isHuman() && t[2].isHuman()).toBe(true); // team 1's squad is human
    expect(!t[3].isHuman() && !t[4].isHuman() && !t[5].isHuman()).toBe(true); // team 2's squad is CPU
    expect(t[0].getTeamId()).toBe(t[2].getTeamId()); // a squad shares one colour/team
    expect(t[0].getTeamId()).not.toBe(t[3].getTeamId()); // the two squads are different teams
    expect(new Set(t.map(x => x.getTeamId())).size).toBe(2); // exactly two teams on the field
  });

  it('total tanks cap at 16 (8 teams × 5 would be 40)', () => {
    const gc = new CGameController(makeCanvas());
    gc.setTanksPerTeam(5);
    gc.startGame(8);
    const t = (gc as unknown as Tanks).m_tanks;
    expect(t).toHaveLength(16); // total tanks capped at 16
  });

  it('the initial (default) setup is always a startable match (≥ 2 players)', () => {
    expect(playersOf(setup.value)).toBeGreaterThanOrEqual(2); // default setup has an opponent
  });

  it('the setup store clamps to the binary ranges', () => {
    setSetup({humans: 99, computers: 99, tanksPerTeam: 99});
    expect(setup.value.humans).toBe(MAX_HUMANS); // humans clamps to max
    expect(setup.value.tanksPerTeam).toBe(MAX_TANKS_PER_TEAM); // tanks clamps to max

    setSetup({humans: -3, computers: -3, tanksPerTeam: -3});
    expect(setup.value.humans).toBe(0); // humans clamps to zero
    expect(setup.value.tanksPerTeam).toBe(1); // tanks clamps to one

    setSetup({humans: 2, computers: 3, tanksPerTeam: 1});
    expect(playersOf(setup.value)).toBe(5); // players = humans + computers

    // A setup from the old {total, humans} schema (no computers / tanksPerTeam) must not
    // yield NaN — the missing fields fall back to sensible defaults.
    setSetup({total: 4, humans: 1} as unknown as Parameters<typeof setSetup>[0]);
    expect(
      Number.isFinite(setup.value.computers) && Number.isFinite(setup.value.tanksPerTeam),
    ).toBe(true); // legacy setup never produces NaN
  });
});
