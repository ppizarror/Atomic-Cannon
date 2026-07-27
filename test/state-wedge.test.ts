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
  m_timers: unknown[];
  m_currentPlayerIndex: number;
  m_netMode: boolean;
  m_onNetTurnEnd: (() => void) | null;
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
    const stale = {at: 0, fn: () => {}}; // its already-scheduled fire()/executeBotTurn closure
    p.m_timers = [stale] as unknown[];

    p.updateBattle(0); // the frame after the passive death

    expect(p.m_currentPlayerIndex).not.toBe(actor); // play advanced to a living tank (was: hung here)
    expect(p.m_gameState).toBe(EGameState.Battle); // a fresh live turn, not wedged
    // The dead actor's stale closure must be dropped, else it would fire against the NEW current tank
    // (wrong-tank / double shot). (beginTurn for the next tank queues ITS own fresh closures instead.)
    expect(p.m_timers.includes(stale)).toBe(false);
  });

  it('the net forfeit latches — it does not re-fire endTurn every frame', () => {
    // In net, endTurn only REPORTS to the server (no local advance), so the dead-actor guard would
    // stay true and burst duplicate turn-end reports each frame without the m_turnForfeited latch.
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(0);
    gc.startGame(3);
    const p = priv(gc);
    p.m_netMode = true;
    let reported = 0;
    p.m_onNetTurnEnd = () => reported++;
    p.m_gameState = EGameState.Battle;
    p.m_tanks[p.m_currentPlayerIndex].m_bIsAlive = false;

    p.updateBattle(0);
    p.updateBattle(0);
    p.updateBattle(0); // three frames still awaiting the server's turnBegin

    expect(reported).toBe(1); // reported exactly once, not once per frame
  });
});
