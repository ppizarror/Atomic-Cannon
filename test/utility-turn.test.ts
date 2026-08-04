/**
 * Utility Turn (Gameplay, default ON): using a utility — Medkit/Repairs (HEAL), shields, armor,
 * hazmat, and Move — spends the turn like a shot. Turned OFF the utility is "free": the effect
 * applies, the human keeps control, and the shot clock RESUMES so the turn still can't be stalled.
 *
 * The self-buffs run through fire() → applyUtility and Move through the drive's finishTankMove, so
 * the flag has to be honoured in BOTH seams. A change to either (an early return, a missed hand-off,
 * a stale net flag) silently turns "use a medkit" into a turn that never ends, or a free Move into
 * one that costs the turn anyway.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {makeCanvas} from './_dom';
import {priv, type GCPriv} from './_internals';
import {CGameController} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE, getWeapon} from '../src/core/CWeapon';
import {EXT} from '../src/core/weapons/ExtType';

const MEDKIT = WEAPON_DATABASE.findIndex(w => w.id === 'medkit');
const MOVE = WEAPON_DATABASE.findIndex(w => w.id === 'move.mid');

/** A 1-human/1-bot battle with the human in control, holding a Medkit and hurt enough to heal. */
function humanWithMedkit(): {gc: CGameController; p: GCPriv; tank: GCPriv['m_tanks'][number]} {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  const p = priv(gc);
  p.m_currentPlayerIndex = p.m_tanks.findIndex(t => t.isHuman());
  const tank = p.m_tanks[p.m_currentPlayerIndex];
  p.economyFor(tank).grant(MEDKIT); // the human owns one — without stock, fire() falls back to the staple
  gc.selectWeapon(MEDKIT);
  tank.hit(300); // 1000 → 700, so a 500-point heal has room to show
  return {gc, p, tank};
}

/** The same battle holding a Move utility instead — placement is armed by FIRE, driven by a click. */
function humanWithMove(): {gc: CGameController; p: GCPriv; tank: GCPriv['m_tanks'][number]} {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  const p = priv(gc);
  p.m_currentPlayerIndex = p.m_tanks.findIndex(t => t.isHuman());
  const tank = p.m_tanks[p.m_currentPlayerIndex];
  p.economyFor(tank).grant(MOVE);
  gc.selectWeapon(MOVE);
  return {gc, p, tank};
}

/** Run past the 0.4s hand-off `schedule` fire() queues when a utility ends the turn. */
const settle = (gc: CGameController) => {
  for (let i = 0; i < 60; i++) gc.update(1 / 60);
};

/** Drive the sim until the tank stops (the waitForRest poll runs at 0.15s of sim time). */
const settleDrive = (gc: CGameController, tank: GCPriv['m_tanks'][number]) => {
  for (let i = 0; i < 900 && tank.isMoving(); i++) gc.update(1 / 30);
  settle(gc); // then let the poll notice and close the move
};

afterEach(() => {
  GameConfig.utilityTurn = true; // the shipped default — never leak a flipped flag to the next test
});

describe('a utility ends the turn (Utility Turn ON — the default)', () => {
  it('the Medkit is a HEAL utility, not a projectile', () => {
    expect(MEDKIT).toBeGreaterThanOrEqual(0);
    expect(getWeapon(MEDKIT).getExtType()).toBe(EXT.HEAL);
  });

  it('heals the firer and hands the turn on', () => {
    GameConfig.utilityTurn = true;
    const {gc, p, tank} = humanWithMedkit();
    const actor = p.m_currentPlayerIndex;

    gc.requestFire();
    settle(gc);

    expect(tank.getHealth().nLife).toBe(1000); // 700 + 500, clamped to max
    expect(p.m_currentPlayerIndex).not.toBe(actor); // the turn moved on, like a shot
  });

  it('a Move drive also hands the turn on', () => {
    GameConfig.utilityTurn = true;
    const {gc, p, tank} = humanWithMove();
    const actor = p.m_currentPlayerIndex;
    const x0 = tank.getPosition().x;

    gc.fire(); // arms click-to-place
    gc.placeMove(x0 + 40); // click a spot inside the move band
    settleDrive(gc, tank);

    expect(Math.abs(tank.getPosition().x - x0)).toBeGreaterThan(5); // it actually drove
    expect(p.m_currentPlayerIndex).not.toBe(actor);
  });
});

describe('a free utility keeps control (Utility Turn OFF)', () => {
  it('heals without ending the turn, and resumes the shot clock', () => {
    GameConfig.utilityTurn = false;
    const {gc, p, tank} = humanWithMedkit();
    const actor = p.m_currentPlayerIndex;

    gc.requestFire();
    settle(gc);

    expect(tank.getHealth().nLife).toBe(1000);
    expect(p.m_currentPlayerIndex).toBe(actor); // still your turn — aim and fire for real
    expect(p.m_turnTimerRunning).toBe(true); // clock running again, so the deadline can't be dodged
  });

  it('clears the net "resolving" flag — nothing is in flight after a free utility', () => {
    GameConfig.utilityTurn = false;
    const {gc, p} = humanWithMedkit();
    p.m_netMode = true; // fire() arms m_netShotResolving for the shot that never happens

    gc.requestFire();
    settle(gc);

    // Left set, the net bridge would queue the server's next hand-off for the rest of a turn that
    // never calls endTurn.
    expect(p.m_netShotResolving).toBe(false);
  });

  it('a Move drives and leaves you in control — the same rule as the self-buffs', () => {
    GameConfig.utilityTurn = false;
    const {gc, p, tank} = humanWithMove();
    const actor = p.m_currentPlayerIndex;
    const x0 = tank.getPosition().x;

    gc.fire();
    gc.placeMove(x0 + 40);
    settleDrive(gc, tank);

    expect(Math.abs(tank.getPosition().x - x0)).toBeGreaterThan(5); // it drove
    expect(p.m_currentPlayerIndex).toBe(actor); // …and the turn is still yours
    expect(gc.canAct()).toBe(true); // input unlocked again (the drive locked it)
    expect(p.m_turnTimerRunning).toBe(true); // clock resumed, exactly as after a free self-buff
    // Nothing is in flight once the drive settles, so the net bridge is free to deliver the
    // server's next hand-off (startTankMove armed the flag for the drive).
    expect(p.m_netShotResolving).toBe(false);
  });

  it('bots always spend their turn on a utility, flag or not', () => {
    GameConfig.utilityTurn = false;
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(2);
    const p = priv(gc);
    const actor = p.m_tanks.findIndex(t => t.isBot());
    p.m_currentPlayerIndex = actor;
    const bot = p.m_tanks[actor];
    p.economyFor(bot).grant(MEDKIT);
    gc.selectWeapon(MEDKIT);
    bot.hit(300);

    gc.fire();
    settle(gc);

    expect(bot.getHealth().nLife).toBe(1000);
    expect(p.m_currentPlayerIndex).not.toBe(actor); // one action per bot turn, always
  });
});
