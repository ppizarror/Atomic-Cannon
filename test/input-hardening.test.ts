/**
 * Input-leak guards:
 *  1. A turn hand-off disowns any aim drag held from the previous turn — beginTurn clears m_aim.active
 *     (world drag bails) and bumps turnSeq (HUD power/angle drags bail). A shot-clock forfeit ends the
 *     turn with no pointerup, so without this a held drag would scrub the NEXT player's aim.
 *  2. Leaving a battle silences the tank-drive / jet loops (they're driven from update(), which stops
 *     running once the sim is frozen on the menu — so the loop would otherwise drone on under the menu).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';
import {CGameController} from '../src/game/CGameController';

function game(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(2);
  gc.startGame(2);
  return gc;
}

describe('input-leak guards', () => {
  it('a turn hand-off disowns a held aim drag and bumps the turn sequence', () => {
    const gc = game();
    const p = priv(gc);
    p.m_aim.active = true; // a drag is being held as the turn ends
    const seq0 = gc.turnSeq();

    p.beginTurn(); // the next turn begins (e.g. after a shot-clock forfeit)

    expect(p.m_aim.active).toBe(false); // world drag now bails (dragAim guards m_aim.active)
    expect(gc.turnSeq()).toBe(seq0 + 1); // HUD power/angle drags captured seq0 → they bail too
  });

  it('stopMovementAudio clears the tank-drive / jet loop state', () => {
    const gc = game();
    const p = priv(gc);
    p.m_tanksMoving = true;
    p.m_jetSounding = true;

    gc.stopMovementAudio();

    expect(p.m_tanksMoving).toBe(false);
    expect(p.m_jetSounding).toBe(false);
  });
});
