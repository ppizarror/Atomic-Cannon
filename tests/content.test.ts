/**
 * Game Content — the Weapons / Landscapes enable lists actually affect play: the
 * default-disabled secret weapons, the enabled-set gating the arsenal / depot /
 * auto-buy, and the landscape picker honouring the enabled landscapes.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, getDefaultWeaponIndex} from '../src/core/CWeapon';
import {GameContent, weaponEnabled, landEnabled} from '../src/core/CGameContent';
import {weaponsOff as pendingWeaponsOff} from '../src/ui/contentStore';
import landData from '../src/data/land.json';

const LAND_COUNT = (landData as unknown[]).length;
const STAPLE = getDefaultWeaponIndex();

describe('Game Content', () => {
  it('secret Organic weapons default disabled, others enabled', () => {
    const organic = WEAPON_DATABASE.findIndex(w => w.type === 'Organic');
    expect(organic).toBeGreaterThanOrEqual(0); // an Organic weapon exists
    expect(pendingWeaponsOff.value.has(organic)).toBe(true); // secret Organic weapon defaults disabled
    expect(pendingWeaponsOff.value.has(STAPLE)).toBe(false); // the staple (Shell) defaults enabled
    expect(pendingWeaponsOff.value.size).toBe(4); // there are exactly 4 default-disabled weapons
  });

  it('weaponEnabled / landEnabled reflect the active GameContent sets', () => {
    GameContent.weaponsOff = new Set([5]);
    GameContent.landsOff = new Set([2]);
    // disabled weapon reads disabled
    expect(weaponEnabled(5)).toBe(false);
    expect(weaponEnabled(0)).toBe(true);
    // disabled landscape reads disabled
    expect(landEnabled(2)).toBe(false);
    expect(landEnabled(0)).toBe(true);
  });

  it('the arsenal hides disabled weapons but always keeps the staple', () => {
    const other = WEAPON_DATABASE.find(w => w.index !== STAPLE)!.index;
    GameContent.weaponsOff = new Set([other, STAPLE]); // even the staple "disabled"
    const gc = new CGameController(makeCanvas());
    const defs = gc.getWeaponDefs();
    expect(defs.some(w => w.index === other)).toBe(false); // disabled weapon absent from the arsenal
    expect(defs.some(w => w.index === STAPLE)).toBe(true); // staple stays available even if disabled
  });

  it('the landscape picker only chooses enabled landscapes', () => {
    GameContent.landsOff = new Set(
      Array.from({length: LAND_COUNT}, (_, i) => i).filter(i => i !== 7),
    );
    const gc = new CGameController(makeCanvas());
    const pick = gc as unknown as {pickLandscapeIndex(): number};
    let onlySeven = true;
    for (let k = 0; k < 60; k++) if (pick.pickLandscapeIndex() !== 7) onlySeven = false;
    expect(onlySeven).toBe(true); // landscape pick honours the enabled set
    GameContent.landsOff = new Set();
  });

  it('auto-buy skips disabled weapons (all off → buys nothing)', () => {
    GameContent.weaponsOff = new Set(WEAPON_DATABASE.map((_, i) => i));
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(50000);
    gc.startGame(2);
    gc.autoBuyWeapons();
    const owned = gc.getOwnedCounts();
    const finiteBought = owned.filter(c => c > 0 && Number.isFinite(c)).length;
    expect(finiteBought).toBe(0); // auto-buy buys nothing when every weapon is disabled
    GameContent.weaponsOff = new Set();
  });
});
