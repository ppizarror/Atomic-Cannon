/**
 * Team-based battle end: a battle is decided when only ONE TEAM has a living tank — not
 * when only one TANK is left. This is what makes squads (Tanks-per-team ≥ 2) work: the
 * winning side ends the battle the moment every enemy team is wiped, even with several of
 * its own tanks still standing. Also: squad bots never target their own teammates.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController, EGameState} from '../src/game/CGameController';

/** A 2-team match with `perTeam` tanks each (1 human team + 1 bot team). */
function squadGame(perTeam: number): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.setTanksPerTeam(perTeam);
  gc.startGame(2);
  return gc;
}

describe('Team-based battle end (squads)', () => {
  it('ends when one team is wiped, even if the winner still fields multiple tanks', () => {
    const gc = squadGame(2);
    const tanks = priv(gc).m_tanks;
    expect(tanks.length).toBe(4); // 2 teams × 2 tanks

    const teams = new Set(tanks.map(t => t.getTeamId()));
    expect(teams.size).toBe(2);

    // Wipe the enemy team; the human's team keeps BOTH of its tanks alive.
    const enemyTeam = tanks[tanks.length - 1].getTeamId();
    tanks.filter(t => t.getTeamId() === enemyTeam).forEach(t => t.hit(999999));
    expect(tanks.filter(t => t.isAlive()).length).toBe(2); // two survivors, one team

    priv(gc).m_gameState = EGameState.Battle;
    priv(gc).endBattleIfDecided();
    // Decided now — it did NOT wait for the winning team to be down to a single tank.
    expect(priv(gc).m_gameState).toBe(EGameState.BattleEnd);
    // The winner banner names a survivor of the winning team.
    const winner = gc.getWinnerName();
    expect(tanks.some(t => t.isAlive() && t.getName() === winner)).toBe(true);
  });

  it('does NOT end while two teams are still alive (one tank down per team)', () => {
    const gc = squadGame(2);
    const tanks = priv(gc).m_tanks;
    // Kill one tank on EACH team — both teams still have a survivor.
    const teamA = tanks[0].getTeamId();
    const teamB = tanks.find(t => t.getTeamId() !== teamA)!.getTeamId();
    tanks.find(t => t.getTeamId() === teamA)!.hit(999999);
    tanks.find(t => t.getTeamId() === teamB)!.hit(999999);

    priv(gc).m_gameState = EGameState.Battle;
    priv(gc).endBattleIfDecided();
    expect(priv(gc).m_gameState).toBe(EGameState.Battle); // two teams left → not decided
  });

  it('a single-tank-per-team match still ends on the last tank (no regression)', () => {
    const gc = squadGame(1);
    const tanks = priv(gc).m_tanks;
    expect(tanks.length).toBe(2);
    tanks[1].hit(999999); // kill the lone enemy
    priv(gc).m_gameState = EGameState.Battle;
    priv(gc).endBattleIfDecided();
    expect(priv(gc).m_gameState).toBe(EGameState.BattleEnd);
    expect(gc.getWinnerName()).toBe(tanks[0].getName());
  });
});
