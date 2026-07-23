/**
 * Rounds/Points game mode (recovered from the original): a SINGLE battle that runs a fixed
 * number of rounds (a round = one full turn-order pass). It does NOT end early on an
 * elimination, dead tanks are not respawned, and the winner is the team with the most
 * POINTS (cumulative net damage dealt) — not kills. Every team tied on points is a Draw.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameState, EGameType} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';

type GCInternals = {
  m_tanks: CTank[];
  m_gameState: EGameState;
  m_currentRound: number;
  endTurn(): void;
  endBattleIfDecided(): void;
};
const priv = (gc: CGameController) => gc as unknown as GCInternals;

function roundsGame(totalRounds: number): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.setGameType(EGameType.Rounds);
  gc.setTotalRounds(totalRounds);
  gc.startGame(2);
  return gc;
}

describe('Rounds / Points mode', () => {
  it('the status line reads "Round N of M", not "Battle …"', () => {
    const gc = roundsGame(7);
    expect(gc.getStatusLine()).toBe('Round 1 of 7');
  });

  it('an elimination does NOT end the game — only the round count does', () => {
    const gc = roundsGame(2);
    const p = priv(gc);

    // Wipe one team. In Deathmatch this ends the battle; in Rounds it must not.
    p.m_tanks[1].hit(999_999);
    expect(p.m_tanks[1].isAlive()).toBe(false);
    p.m_gameState = EGameState.Battle;
    p.endBattleIfDecided();
    expect(p.m_gameState).toBe(EGameState.Battle); // still going

    // Drive turns until it ends on its own — that must be by the round count.
    let guard = 0;
    while (p.m_gameState === EGameState.Battle && guard++ < 200) p.endTurn();
    expect(p.m_gameState).toBe(EGameState.BattleEnd);
    expect(p.m_currentRound).toBeGreaterThan(2); // played the full count (counter passed N)
  });

  it('the winner is the team with the most POINTS (damage), not kills', () => {
    const gc = roundsGame(2);
    const p = priv(gc);
    const [t0, t1] = p.m_tanks;

    // t1 racks up kills; t0 deals the most damage. Points must win the standings.
    t1.addKill();
    t1.addKill();
    t0.addHit(500); // net damage dealt → points

    const s = gc.getWarStandings();
    expect(s.pointsMode).toBe(true);
    const leader = s.rows.find(r => r.isLeader);
    expect(leader?.name).toBe(t0.getName()); // most points, despite fewer kills
    expect(leader?.points).toBe(500);
    expect(s.title).toContain(t0.getName());
  });

  it('every team level on points is a Draw', () => {
    const gc = roundsGame(2);
    const s = gc.getWarStandings();
    // No damage dealt yet → all teams on 0 points → a draw, no leader.
    expect(s.rows.some(r => r.isLeader)).toBe(false);
    expect(s.title).toBe("It's a draw!");
  });
});
