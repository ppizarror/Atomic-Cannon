/**
 * Large-map camera follow target: hold on the last impact for the WHOLE shot-resolution window (until
 * the turn hands off), then follow the current tank. Keyed on the game STATE — using hasActiveBlast()
 * released too early (camera eased toward the shooter during the post-blast settle), and the original
 * hasActiveExplosions() held too long (parked on the old crater's smoke into the next turn).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import type {CTank} from '../src/core/CTank';

type Priv = {
  m_lastImpactX: number;
  m_activeShot: unknown;
  m_shots: unknown[];
  m_gameState: EGameState;
  m_impactThisTurn: boolean;
  m_viewW: number;
  m_camera: {reset(): void; isDwelling(): boolean};
  m_currentPlayerIndex: number;
  m_tanks: CTank[];
  cameraFollowX(): number;
  beginTurn(): void;
  getCurrentTank(): {getPosition(): {x: number}};
  getWinnerTank(): CTank | null;
};

function game(): {gc: CGameController; p: Priv} {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  return {gc, p: gc as unknown as Priv};
}

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

describe('camera hand-off mode (Graphics → Camera)', () => {
  function dwellForMode(mode: number, impact = true): boolean {
    const {p} = game();
    p.m_viewW = 1; // force the current tank off-screen so the hand-off branch runs
    p.m_camera.reset();
    p.m_impactThisTurn = impact; // did a blast land on the turn that just ended?
    const prev = GameConfig.cameraMode;
    GameConfig.cameraMode = mode;
    try {
      p.beginTurn();
      return p.m_camera.isDwelling();
    } finally {
      GameConfig.cameraMode = prev;
    }
  }

  it('Cinematic dwells only after a blast landed; Smooth and Instant never dwell', () => {
    expect(dwellForMode(2, true)).toBe(true); // Cinematic + a blast this turn → linger
    expect(dwellForMode(2, false)).toBe(false); // Cinematic but a SHOTLESS turn → no wrong-way pan
    expect(dwellForMode(0)).toBe(false); // Smooth — just eases, no dwell
    expect(dwellForMode(1)).toBe(false); // Instant — snaps, no dwell
  });
});

describe('battle-over camera', () => {
  it('frames the winner, not whoever acted last', () => {
    const {p} = game();
    p.m_activeShot = null;
    p.m_shots = [];
    p.m_camera.reset();
    const [a, b] = p.m_tanks;
    (a as unknown as {addKill(): void}).addKill(); // a's team leads
    (b as unknown as {hit(n: number): number}).hit(1e9); // the loser dies
    p.m_currentPlayerIndex = p.m_tanks.indexOf(b); // the LAST actor is the loser
    p.m_gameState = EGameState.BattleEnd;

    expect(p.getWinnerTank()).toBe(a); // sanity: the survivor won
    expect(p.cameraFollowX()).toBe(a.getPosition().x); // camera frames the winner, not the last actor (b)
  });
});
