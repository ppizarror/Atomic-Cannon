/**
 * Rounds/Points game mode (recovered from the original): a SINGLE battle that runs a fixed
 * number of rounds (a round = one full turn-order pass). It is NON-LETHAL — a tank bottoms out
 * at 0 life but is never destroyed and keeps taking turns (faithful to the original, whose per-hit
 * dead-flag/explosion is gated to Deathmatch; the manual says "no tank is ever destroyed"). So it
 * never ends early on an elimination, and the winner is the team with the most POINTS (cumulative
 * net damage dealt) — not kills. Every team tied on points is a Draw.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController, EGameState, EGameType} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';

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

  it('is non-lethal: a hit that would kill only bottoms life at 0 — the tank lives on', () => {
    const gc = roundsGame(2);
    const p = priv(gc);

    // A massive hit in Rounds must NOT destroy the tank (it does in Deathmatch). Life floors at 0
    // but the tank stays alive and keeps its turn — "no tank is ever destroyed".
    p.m_tanks[1].hit(999_999);
    expect(p.m_tanks[1].isAlive()).toBe(true); // never destroyed in Rounds
    expect(p.m_tanks[1].getHealth().nLife).toBe(0); // life still bottoms out at 0
  });

  it('an elimination never happens, so the game ends only on the round count', () => {
    const gc = roundsGame(2);
    const p = priv(gc);

    // Even a would-be-fatal blast leaves both teams standing → the battle can't end early.
    p.m_tanks[1].hit(999_999);
    p.m_gameState = EGameState.Battle;
    p.endBattleIfDecided();
    expect(p.m_gameState).toBe(EGameState.Battle); // still going — no team was wiped

    // Drive turns until it ends on its own — that must be by the round count.
    let guard = 0;
    while (p.m_gameState === EGameState.Battle && guard++ < 200) p.endTurn();
    expect(p.m_gameState).toBe(EGameState.BattleEnd);
    expect(p.m_currentRound).toBeGreaterThan(2); // played the full count (counter passed N)
  });

  it('Deathmatch, by contrast, DOES destroy a tank at 0 life', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.setGameType(EGameType.Deathmatch);
    gc.startGame(2);
    const t = priv(gc).m_tanks;
    t[1].hit(999_999);
    expect(t[1].isAlive()).toBe(false); // lethal in Deathmatch
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

  it('Explode Losers (ON) detonates the non-winning team once the battle ends', () => {
    GameConfig.explodeLosers = true;
    const gc = roundsGame(1);
    const p = priv(gc);
    const [t0, t1] = p.m_tanks;
    t0.addHit(500); // t0's team leads on points → t1 is the loser

    let guard = 0;
    while (p.m_gameState === EGameState.Battle && guard++ < 200) p.endTurn();
    expect(p.m_gameState).toBe(EGameState.BattleEnd);
    expect(t1.isAlive()).toBe(true); // Rounds is non-lethal, so it survives INTO the end screen…

    // …then the scheduled wipeout cascade fires as the end screen animates.
    for (let i = 0; i < 12; i++) gc.update(0.1);
    expect(t1.isAlive()).toBe(false); // loser detonated
    expect(t0.isAlive()).toBe(true); // winner spared
  });

  it('starting a new match clears the pending loser-cascade (no leak into the next game)', () => {
    GameConfig.explodeLosers = true;
    const gc = roundsGame(1);
    const p = priv(gc);
    p.m_tanks[0].addHit(500); // give a clear winner so losers get scheduled

    let guard = 0;
    while (p.m_gameState === EGameState.Battle && guard++ < 200) p.endTurn();
    expect(p.m_timers.length).toBeGreaterThan(0); // the cascade is queued at battle end

    gc.startGame(2); // begin a fresh match before the cascade drains
    expect(p.m_timers.length).toBe(0); // stale timers dropped → no phantom explosions next match
  });

  it('Explode Losers (OFF) leaves every tank standing at the end screen', () => {
    GameConfig.explodeLosers = false;
    const gc = roundsGame(1);
    const p = priv(gc);
    const [t0, t1] = p.m_tanks;
    t0.addHit(500);

    let guard = 0;
    while (p.m_gameState === EGameState.Battle && guard++ < 200) p.endTurn();
    for (let i = 0; i < 12; i++) gc.update(0.1);
    expect(t0.isAlive()).toBe(true);
    expect(t1.isAlive()).toBe(true); // no wipeout when the setting is off
    GameConfig.explodeLosers = true; // restore the default for the rest of the file
  });

  it('every team level on points is a Draw', () => {
    const gc = roundsGame(2);
    const s = gc.getWarStandings();
    // No damage dealt yet → all teams on 0 points → a draw, no leader.
    expect(s.rows.some(r => r.isLeader)).toBe(false);
    expect(s.title).toBe("It's a draw!");
  });
});
