/**
 * Kill attribution must only change on a hit that actually removed life. A shot fully soaked by an
 * all-or-nothing shield / 100% armor removes 0 life; if it still reassigned the victim's last-damager,
 * a harmless graze would STEAL the kill (and the kill credit) when the victim later dies to the earlier
 * real damage — e.g. radiation DOT started by a different tank.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import type {CTank} from '../src/core/CTank';

type Priv = {
  m_tanks: CTank[];
  creditDamage(shooter: CTank | null, victim: CTank, lifeRemoved: number): void;
};

function game(): Priv {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(0);
  gc.startGame(3);
  return gc as unknown as Priv;
}

describe('kill attribution vs zero-damage hits', () => {
  it('a zero-life-removed hit does not overwrite the real last-damager', () => {
    const p = game();
    const [a, b, c] = p.m_tanks;

    p.creditDamage(a, b, 40); // A deals real damage to B → A is B's killer-to-be
    expect(b.getLastDamager()).toBe(a);

    p.creditDamage(c, b, 0); // C's shot is fully absorbed (shield/armor) → 0 life removed

    // Before the fix, setLastDamager ran before the lifeRemoved<=0 guard → this stole attribution.
    expect(b.getLastDamager()).toBe(a); // still A, not C
  });

  it('a real follow-up hit still updates the last-damager', () => {
    const p = game();
    const [a, b, c] = p.m_tanks;

    p.creditDamage(a, b, 40);
    p.creditDamage(c, b, 25); // C now deals REAL damage → C legitimately becomes the last-damager

    expect(b.getLastDamager()).toBe(c);
  });
});
