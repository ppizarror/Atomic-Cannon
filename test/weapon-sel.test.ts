/**
 * `?weaponsel=<n>` selects the weapon the arsenal list prints as row `n`. The list hides
 * everything disabled in Game Content, so a disabled weapon must NOT consume a number —
 * resolving `n` as a raw database index lands short by the number switched off (with the
 * four secret Organic weapons off, `weaponsel=101` reached the row labelled "97.").
 */
import {describe, it, expect, afterEach} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, weaponName} from '../src/core/CWeapon';
import {GameContent} from '../src/core/CGameContent';

const indexOfName = (name: string): number => WEAPON_DATABASE.find(w => weaponName(w) === name)!.index;

/** Switch weapons off the way the shipped default does (the secret Organic set). */
function disable(...names: string[]): void {
  GameContent.weaponsOff = new Set(names.map(indexOfName));
}

/** A match with a human at index 0 and free-fire on, so the arsenal list is every enabled
 *  weapon in database order — exactly what `?weapontest=1&weaponsel=<n>` puts on screen. */
function weaponTestGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  gc.setWeaponTest(true);
  return gc;
}

/** The numbers the HUD prints, straight off the live list (`Hud.tsx` renders `i + 1`). */
const listNumberOf = (gc: CGameController, name: string): number =>
  gc.getWeaponDefs().findIndex(w => weaponName(w) === name) + 1;

afterEach(() => {
  GameContent.weaponsOff = new Set();
});

describe('weaponsel (arsenal row selection)', () => {
  it('selects the weapon printed at that row number', () => {
    const gc = weaponTestGame();
    for (const name of ['Machine Gun', 'Tracer 5', 'Booster Jet', 'Stingers']) {
      const n = listNumberOf(gc, name);
      expect(n).toBeGreaterThan(0); // the weapon really is on the list
      expect(gc.forceWeaponByListNumber(n)).toBe(true);
      expect(gc.getCurrentWeapon().getName()).toBe(name);
    }
  });

  it('disabled weapons do not consume row numbers', () => {
    // The reported regression, with the shipped defaults: the four secret Organic weapons sit
    // before Booster Jet, so its database id (101) runs four ahead of its row number (97).
    disable('Pig Blaster', 'Cowinator', 'Toxic Cow', 'Defiled Pig');
    const gc = weaponTestGame();
    const booster = indexOfName('Booster Jet');
    const offBefore = [...GameContent.weaponsOff].filter(i => i < booster).length;
    expect(offBefore).toBe(4); // the two numberings genuinely differ here
    const row = listNumberOf(gc, 'Booster Jet');
    expect(row).toBe(booster + 1 - offBefore);

    // The row number lands on Booster Jet…
    expect(gc.forceWeaponByListNumber(row)).toBe(true);
    expect(gc.getCurrentWeapon().getName()).toBe('Booster Jet');
  });

  it('turning a weapon off shifts every row after it down by one', () => {
    const gc = weaponTestGame();
    const before = listNumberOf(gc, 'Tracer 5');

    disable('Cluster Bomb', 'Runway Bomb', 'Grave Digger'); // three rows ahead of Tracer 5
    const gc2 = weaponTestGame();
    expect(listNumberOf(gc2, 'Tracer 5')).toBe(before - 3); // row moved up by 3
    expect(gc2.forceWeaponByListNumber(before - 3)).toBe(true);
    expect(gc2.getCurrentWeapon().getName()).toBe('Tracer 5'); // …and the flag follows it
  });

  it('a row number past the end of the arsenal selects nothing', () => {
    const gc = weaponTestGame();
    const rows = gc.getWeaponDefs().length;
    gc.forceWeaponByListNumber(1);
    const picked = gc.getCurrentWeapon().getName();
    expect(gc.forceWeaponByListNumber(rows + 1)).toBe(false);
    expect(gc.getCurrentWeapon().getName()).toBe(picked); // selection untouched
  });
});
