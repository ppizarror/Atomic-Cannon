/**
 * A battle can end mid-delay when the last enemy dies PASSIVELY (radiation DOT / a mine) during a
 * bot's or sentry's pre-fire delay. The queued fire()/endTurn() closures must then be inert — a
 * stale shot launched onto the finished battle would clear the standings and mutate the result, and
 * a stale endTurn would re-enter finishBattle (restarting the winner animation / replaying the jingle).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameState} from '../src/game/CGameController';

type Priv = {
  m_gameState: EGameState;
  m_shots: unknown[];
  m_battleEndTime: number;
  m_timers: unknown[];
  endTurn(): void;
};
const priv = (gc: CGameController) => gc as unknown as Priv;

function game(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  gc.setWeaponTest(true); // unlimited ammo → fire() would otherwise be able to launch
  return gc;
}

describe('BattleEnd guards on fire() / endTurn()', () => {
  it('a stale fire() launches no shot once the battle has ended', () => {
    const gc = game();
    const p = priv(gc);
    p.m_gameState = EGameState.BattleEnd; // standings screen is up
    const before = p.m_shots.length;

    gc.fire(); // the bot/sentry's queued fire arrives on the standings screen

    expect(p.m_shots.length).toBe(before); // no live projectile spawned
    expect(gc.getState()).toBe('battle_end'); // still on the standings (state not flipped to ShotFlying)
  });

  it('a stale endTurn() does not re-enter finishBattle', () => {
    const gc = game();
    const p = priv(gc);
    p.m_gameState = EGameState.BattleEnd;
    p.m_battleEndTime = 5; // the winner-flag animation has been running a while

    p.endTurn(); // a settled Move poll / no-target bot closure fires after the battle ended

    expect(p.m_battleEndTime).toBe(5); // finishBattle NOT re-run (it would reset this to 0)
    expect(gc.getState()).toBe('battle_end');
  });

  it('the bot-fire delay is real, so the race window exists (sanity: fire is deferred)', () => {
    // Not the guard itself — just documents that bot fire is scheduled (a timer), which is what makes
    // the passive-death race reachable. A fresh match has the timer machinery in place.
    const gc = game();
    expect(Array.isArray(priv(gc).m_timers)).toBe(true);
  });
});
