/**
 * Heal clamp: addLife (the Repair/Medkit utility path) refills toward the tank's MAX life for
 * THIS match — HitPoints is a setting (100–5000), so a heal must not be pinned at a hard 1000.
 */
import {describe, it, expect} from 'vitest';

import {CTank} from '../src/core/CTank';

describe('addLife clamps to the tank max life, not a hard 1000', () => {
  it('a high-HitPoints tank heals past 1000, up to its max', () => {
    const tank = new CTank('Big', 0);
    tank.setMaxLife(5000); // refills to full 5000
    tank.hit(4000); // → 1000 remaining
    expect(tank.getHealth().nLife).toBe(1000);

    tank.addLife(2500); // must NOT be capped at 1000
    expect(tank.getHealth().nLife).toBe(3500);

    tank.addLife(9999); // overheal request → capped at THIS tank's max
    expect(tank.getHealth().nLife).toBe(5000);
  });

  it('a low-HitPoints tank cannot overheal past its small max', () => {
    const tank = new CTank('Small', 0);
    tank.setMaxLife(100);
    tank.addLife(9999);
    expect(tank.getHealth().nLife).toBe(100);
  });

  it('a heal never drops life below zero', () => {
    const tank = new CTank('Neg', 0);
    tank.setMaxLife(1000);
    tank.addLife(-9999);
    expect(tank.getHealth().nLife).toBe(0);
  });
});
