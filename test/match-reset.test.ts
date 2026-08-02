/**
 * Match-to-match state: starting a new SOLO match must reset the battle-progress counters. They are
 * maintained WITHIN a war by nextBattle, but if a fresh startGame inherits the previous war's end
 * values, the 2nd+ match in a session breaks: a Deathmatch ends after one battle (currentBattle >=
 * total), a Rounds match after one round (currentRound > total), and the "Shot N" HUD counter keeps
 * climbing all session. (The net path sets currentBattle itself, so the reset is solo-only.)
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';
import {CGameController} from '../src/game/CGameController';

describe('new-match reset', () => {
  it('startGame restarts battle/round/shot counters left high by a previous war', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(2);

    const p = priv(gc);
    p.m_currentBattle = 5; // pretend a prior war finished with these high
    p.m_currentRound = 12;
    p.m_shotsFired = 47;

    gc.startGame(2); // start a brand-new match

    expect(p.m_currentBattle).toBe(1); // was: stayed 5 → new war ends after one battle
    expect(p.m_currentRound).toBe(1); // was: stayed 12 → new Rounds match ends after one round
    expect(p.m_shotsFired).toBe(0); // was: kept climbing across matches
  });
});
