/**
 * The shot clock (Shot Time) is paused — not cleared — when a human spends part of a turn on a jet
 * flight or a free utility (Utility-Turn off). fire() stops the countdown; when control is handed
 * back to the human, armShotClock(false) RESUMES it from where it paused. Without that resume the
 * clock stayed dead for the rest of the turn, so a player could dodge the deadline indefinitely by
 * jetting / spamming free utilities. A brand-new turn arms a FRESH clock via armShotClock(true).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';

type Priv = {
  m_currentPlayerIndex: number;
  m_turnElapsed: number;
  m_turnTimerRunning: boolean;
  m_tanks: {isHuman(): boolean}[];
  armShotClock(fresh: boolean): void;
};

function humanController(): {gc: CGameController; p: Priv} {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2); // 1 human + 1 bot; shot time defaults to 30s, no weapon-test → clock is live
  const p = gc as unknown as Priv;
  p.m_currentPlayerIndex = p.m_tanks.findIndex(t => t.isHuman()); // put the human in control
  return {gc, p};
}

describe('shot clock re-arm after jet / free utility', () => {
  it('resumes the paused countdown without refunding elapsed time', () => {
    const {p} = humanController();
    p.m_turnElapsed = 12; // 12s already spent aiming
    p.m_turnTimerRunning = false; // fire() paused the clock to ignite a jet / apply a free utility

    p.armShotClock(false); // flight/utility over → control back to the human

    expect(p.m_turnTimerRunning).toBe(true); // clock runs again (was permanently dead before the fix)
    expect(p.m_turnElapsed).toBe(12); // resumed, NOT refilled — the deadline can't be dodged
  });

  it('a fresh turn resets the countdown', () => {
    const {p} = humanController();
    p.m_turnElapsed = 12;

    p.armShotClock(true); // new turn

    expect(p.m_turnTimerRunning).toBe(true);
    expect(p.m_turnElapsed).toBe(0); // full budget for the new turn
  });
});
