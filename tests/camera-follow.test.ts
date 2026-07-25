/**
 * Large-map camera follow target: hold on the last impact for the WHOLE shot-resolution window (until
 * the turn hands off), then follow the current tank. Keyed on the game STATE — using hasActiveBlast()
 * released too early (camera eased toward the shooter during the post-blast settle), and the original
 * hasActiveExplosions() held too long (parked on the old crater's smoke into the next turn).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';

type Priv = {
  m_lastImpactX: number;
  m_activeShot: unknown;
  m_shots: unknown[];
  m_gameState: EGameState;
  cameraFollowX(): number;
  getCurrentTank(): {getPosition(): {x: number}};
};

describe('camera follow target', () => {
  it('holds the impact during shot resolution, follows the tank once the turn is live', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(2);
    const p = gc as unknown as Priv;
    p.m_activeShot = null; // no live shot → the state-based branch decides
    p.m_shots = [];
    p.m_lastImpactX = 1234;

    p.m_gameState = EGameState.Explosion; // blast + settle → hold the crater the whole time
    expect(p.cameraFollowX()).toBe(1234);

    p.m_gameState = EGameState.ShotFlying; // between salvos → still hold the impact
    expect(p.cameraFollowX()).toBe(1234);

    p.m_gameState = EGameState.Battle; // turn is live → follow the current tank, NOT the old crater
    expect(p.cameraFollowX()).toBe(p.getCurrentTank().getPosition().x);
  });
});
