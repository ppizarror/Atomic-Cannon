/**
 * Guards against two latent state-machine wedges:
 *  1. A succession burst interrupted by Quit→menu freezes the sim mid-count, leaving m_pendingSalvos
 *     nonzero. A new match must clear it — otherwise the first ShotFlying-entering shot that does NOT
 *     reassign it (a Death round) is held in ShotFlying forever (updateShotInFlight waits on pending
 *     salvos that no timer will ever decrement), wedging the turn.
 *  2. A stale queued bot turn arriving on a settled battle / in-flight shot must be inert: botMove→
 *     startTankMove sets state back to Battle, so an unguarded executeBotTurn could un-finish a battle.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';

type Priv = {
  m_pendingSalvos: number;
  m_gameState: EGameState;
  m_shots: unknown[];
  m_currentPlayerIndex: number;
  m_tanks: {m_bIsAlive: boolean; getTeamId(): number}[];
  executeBotTurn(): void;
  updateBattle(dt: number): void;
};
const priv = (gc: CGameController) => gc as unknown as Priv;

function game(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  gc.setWeaponTest(true);
  return gc;
}

describe('state-machine wedge guards', () => {
  it('a new match clears a stale succession-salvo counter', () => {
    const gc = game();
    priv(gc).m_pendingSalvos = 11; // a burst was interrupted mid-count (Quit→menu froze the sim)

    gc.startGame(2); // start a fresh match

    // Without the reset this stays 11 and any Death-round shot wedges in ShotFlying forever.
    expect(priv(gc).m_pendingSalvos).toBe(0);
  });

  it('a stale queued bot turn does not restart a finished battle', () => {
    const gc = game();
    const p = priv(gc);
    p.m_gameState = EGameState.BattleEnd; // the battle has already been decided

    p.executeBotTurn(); // a bot's pre-fire delay closure fires late, on the standings screen

    // The guard keeps it inert — botMove→startTankMove must NOT flip state back to Battle.
    expect(p.m_gameState).toBe(EGameState.BattleEnd);
  });

  it('forfeits the turn when the ACTING tank dies passively mid-turn (no hang)', () => {
    // 3 solo bots on distinct teams: a mid-turn passive death (radiation DOT / a mine) leaves 2 teams
    // → the battle is UNDECIDED, so endBattleIfDecided won't fire. Bots have no shot clock and the
    // scheduled fire() bails on a dead tank without handing off, so without the forfeit the match hangs.
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(0); // all bots → no human shot clock to mask a hang
    gc.startGame(3);
    const p = priv(gc);
    expect(new Set(p.m_tanks.map(t => t.getTeamId())).size).toBe(3); // FFA: one death stays undecided

    p.m_gameState = EGameState.Battle;
    const actor = p.m_currentPlayerIndex;
    p.m_tanks[actor].m_bIsAlive = false; // the acting bot just died to radiation / a mine

    p.updateBattle(0); // the frame after the passive death

    expect(p.m_currentPlayerIndex).not.toBe(actor); // play advanced to a living tank (was: hung here)
    expect(p.m_gameState).toBe(EGameState.Battle); // a fresh live turn, not wedged
  });
});
