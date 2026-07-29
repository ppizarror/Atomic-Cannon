/**
 * Opening aim: every tank starts a battle on its own random angle over the upward half-circle
 * (0..180) instead of all barrels frozen at 45°. Drawn from the seeded match RNG so a network
 * match opens identically on every client, and re-drawn at each battle of a war.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';

type Internals = {m_tanks: CTank[]; nextBattle(): void};
const priv = (gc: CGameController) => gc as unknown as Internals;

function match(players = 8, perTeam = 2): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.setTanksPerTeam(perTeam);
  gc.startGame(players);
  return gc;
}

describe('Opening aim', () => {
  it('every tank starts on its own angle, inside the upward half-circle', () => {
    const aims = priv(match()).m_tanks.map(t => t.getAimAngle());
    expect(aims).toHaveLength(16);
    for (const a of aims) {
      expect(Number.isInteger(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0); // 0 = flat right
      expect(a).toBeLessThanOrEqual(180); // 180 = flat left; never below the horizon
    }
    // Not the old shared 45°: 16 draws landing on one value is not a plausible pass.
    expect(new Set(aims).size).toBeGreaterThan(1);
  });

  it('the human opens the battle on its own drawn aim (the HUD reads it)', () => {
    const gc = match();
    const human = priv(gc).m_tanks.find(t => t.isHuman())!;
    // startGame ends in beginTurn, which mirrors the acting tank's aim into the panel.
    expect(gc.getAngle()).toBe(human.getAimAngle());
  });

  it('Reset returns to the drawn aim, not to a 45° the tank never held', () => {
    // resetAim is documented to restore the last shot, with the last-shot fields seeded to the
    // starting aim before the first shot — so the draw has to seed them too.
    const gc = match();
    const human = priv(gc).m_tanks.find(t => t.isHuman())!;
    const opening = human.getAimAngle();
    gc.setAngle(123);
    gc.resetAim();
    expect(gc.getAngle()).toBe(opening);
  });

  it('a fresh battle re-draws the aim', () => {
    const gc = match(4, 1);
    gc.setTotalBattles(5); // nextBattle is a no-op once the war is over
    const before = priv(gc).m_tanks.map(t => t.getAimAngle());
    priv(gc).nextBattle();
    const after = priv(gc).m_tanks.map(t => t.getAimAngle());
    expect(after).not.toEqual(before); // a new battle is a new opening, like the fresh terrain
    for (const a of after) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(180);
    }
  });
});
