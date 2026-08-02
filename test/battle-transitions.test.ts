/**
 * Battle → next-battle transitions: the win/lose jingle must give way to a fresh
 * battle bed on the next battle, and a battle must END the instant only one side
 * is left — even when the killing blow lands passively (radiation / mine) during a
 * player's turn, without them firing a needless final shot.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController, EGameType, EGameState} from '../src/game/CGameController';
import type {CAudio} from '../src/audio/CAudio';
import {CTank} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';

// A fake audio facade that just counts which semantic events were fired. Every
// method is a no-op counter, so the controller can drive it freely in headless.
function makeAudio(): {calls: Record<string, number>; audio: CAudio} {
  const calls: Record<string, number> = {};
  const audio = new Proxy(
    {},
    {
      get:
        (_t, k: string) =>
        (..._args: unknown[]) => {
          calls[k] = (calls[k] ?? 0) + 1;
          return undefined;
        },
    },
  );
  return {calls, audio: audio as unknown as CAudio};
}

// A 2-player Deathmatch (human tank[0] + one CPU tank[1]) with the audio wired in
// BEFORE startGame, so the opening battleMusic() is counted too.
function newGame(): {gc: CGameController; calls: Record<string, number>; t: CTank[]} {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  const {calls, audio} = makeAudio();
  gc.setAudio(audio);
  gc.setGameType(EGameType.Deathmatch);
  gc.setTotalBattles(5);
  gc.startGame(2);
  return {gc, calls, t: priv(gc).m_tanks};
}

describe('Battle transitions', () => {
  // Regression: the win was only detected when a shot resolved, so the human had
  // to fire a pointless final round to actually win.
  it('ends the battle when the enemy dies mid-turn, without firing', () => {
    const {gc, calls, t} = newGame();
    expect(gc.getState()).toBe(EGameState.Battle); // human to act
    expect(t[0].isAlive() && t[0].isHuman()).toBe(true);

    // The lone enemy dies passively (models radiation fallout / a mine kill mid-turn):
    // no shot fired, no state change yet.
    t[1].hit(999999);
    expect(gc.getState()).toBe(EGameState.Battle); // nothing polled yet

    // One update tick with NO fire must be enough to declare the win.
    gc.update(0.016);
    expect(gc.getState()).toBe(EGameState.BattleEnd);
    expect(calls.battleWon).toBe(1); // human survived
    expect(calls.battleLost).toBeUndefined();
  });

  it('does not end early while two sides are still alive', () => {
    const {gc, t} = newGame();
    gc.update(0.016);
    expect(gc.getState()).toBe(EGameState.Battle);
    expect(t[0].isAlive() && t[1].isAlive()).toBe(true);
  });

  // Regression: nextBattle never touched the music, so the victory track lingered
  // and no new bed started.
  it('starts a fresh bed on the next battle, cutting the win jingle', () => {
    const {gc, calls, t} = newGame();
    expect(calls.battleMusic).toBe(1); // opening battle started a bed

    // End the first battle as a human win.
    t[1].hit(999999);
    gc.update(0.016);
    expect(gc.getState()).toBe(EGameState.BattleEnd);
    expect(calls.battleWon).toBe(1);
    const bedsBefore = calls.battleMusic;

    gc.nextBattle();
    expect(gc.getState()).toBe(EGameState.Battle);
    expect(gc.getBattleNum()).toBe(2);
    expect(calls.battleMusic).toBe(bedsBefore + 1); // new bed replaces the jingle
    expect(t[0].isAlive() && t[1].isAlive()).toBe(true); // respawned full
  });
});
