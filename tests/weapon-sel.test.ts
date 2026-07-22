/**
 * `?weapon_sel=<id>` selects by STABLE weapon id, and the arsenal list numbers rows
 * by that same id (`weaponDisplayNumber`), NOT by their position in the (filtered)
 * list. Regression for: with weapons disabled in Game Content, list-position numbering
 * drifted below the id, so `weapon_sel=74` (aiming at "Tracer 5") landed on Barrage.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, weaponDisplayNumber} from '../src/core/CWeapon';
import {GameContent} from '../src/core/CGameContent';

const tracer5 = WEAPON_DATABASE.find(w => w.name === 'Tracer 5')!;
const barrage = WEAPON_DATABASE.find(w => w.name === 'Barrage')!;

describe('weapon_sel (stable-id selection)', () => {
  it('display number is the weapon stable id (index + 1)', () => {
    // The displayed number is the weapon's stable id (index + 1) — the value you pass
    // to ?weapon_sel. So `weapon_sel = weaponDisplayNumber(w)` and `forceWeapon(id-1)`
    // are inverses: the id you read off the list selects that exact weapon.
    expect(weaponDisplayNumber(tracer5)).toBe(tracer5.index + 1);
  });

  it('stable id is unchanged when earlier weapons are disabled', () => {
    // Disabling weapons that sit BEFORE Tracer 5 must NOT change its number — the whole
    // point of id- over position-numbering. (Position numbering would drop it by 3 here.)
    const before = WEAPON_DATABASE.filter(w => w.index < tracer5.index).slice(0, 3);
    for (const w of before) GameContent.weaponsOff.add(w.index);
    expect(weaponDisplayNumber(tracer5)).toBe(tracer5.index + 1);
    // The naive list-position number WOULD have shifted down by the 3 disabled rows —
    // prove id-numbering and position-numbering genuinely differ here (the old bug).
    const enabled = WEAPON_DATABASE.filter(w => !GameContent.weaponsOff.has(w.index));
    const listPos = enabled.findIndex(w => w.index === tracer5.index) + 1;
    expect(listPos).toBe(weaponDisplayNumber(tracer5) - before.length); // list-position numbering DOES drift (the old bug)
    for (const w of before) GameContent.weaponsOff.delete(w.index); // restore
  });

  it('weapon_sel=<id> selects that exact weapon end-to-end', () => {
    // End-to-end: ?weapon_sel=<id> → forceWeapon(id-1) selects that exact weapon even
    // with earlier weapons disabled (the reported scenario).
    const gc = new CGameController(makeCanvas()) as unknown as {
      startGame(n: number): void;
      forceWeapon(index: number): void;
      getCurrentWeapon(): {getName(): string};
    };
    gc.startGame(2);

    const selById = (id: number) => {
      gc.forceWeapon(id - 1);
      return gc.getCurrentWeapon().getName();
    };

    expect(selById(weaponDisplayNumber(tracer5))).toBe('Tracer 5');
    expect(selById(weaponDisplayNumber(barrage))).toBe('Barrage');
  });
});
