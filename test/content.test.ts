/**
 * Game Content — the Weapons / Landscapes enable lists actually affect play: the rows the
 * weapon data flags `disabled`, the enabled-set gating the arsenal / depot / auto-buy, and
 * the landscape picker honouring the enabled landscapes.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, getDefaultWeaponIndex} from '../src/core/CWeapon';
import {GameContent, weaponEnabled, landEnabled} from '../src/core/CGameContent';
import {
  weaponsOff as pendingWeaponsOff,
  weaponsOffFromStored,
  weaponsOffToStored,
} from '../src/ui/contentStore';
import landData from '../src/data/land.json';

const LAND_COUNT = (landData as unknown[]).length;
const STAPLE = getDefaultWeaponIndex();
const idOf = (i: number) => WEAPON_DATABASE[i].id;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('Game Content', () => {
  it('the JSON `disabled` flag is exactly what defaults off', () => {
    // A weapon's default state lives in its own row and nowhere else: `"disabled": true` starts
    // it off, everything else starts on. No type/index/version rule on top.
    const flagged = WEAPON_DATABASE.filter(w => w.disabled).map(w => w.index);
    expect(flagged.length).toBeGreaterThan(0); // some weapon is flagged, so this has teeth
    expect(sorted(pendingWeaponsOff.value)).toEqual(flagged);
    expect(pendingWeaponsOff.value.has(STAPLE)).toBe(false); // the staple (Shell) defaults enabled
  });

  it('a stored id map is read back by id, not by position', () => {
    // The point of keying by id: the saved selection means the same thing however the database
    // grows or shifts underneath it.
    const map = Object.fromEntries(WEAPON_DATABASE.map(w => [w.id, true]));
    map[idOf(3)] = false;
    map[idOf(7)] = false;
    expect(sorted(weaponsOffFromStored(map))).toEqual([3, 7]);
  });

  it('only the player’s overrides are stored — an untouched profile stores nothing', () => {
    const def = new Set(WEAPON_DATABASE.filter(w => w.disabled).map(w => w.index));
    expect(weaponsOffToStored(def)).toEqual({}); // exactly the data's defaults → no overrides

    const optIn = WEAPON_DATABASE.find(w => w.disabled)!; // turn a default-off weapon ON
    const optOut = WEAPON_DATABASE.find(w => !w.disabled)!; // and a default-on weapon OFF
    const edited = new Set(def);
    edited.delete(optIn.index);
    edited.add(optOut.index);
    expect(weaponsOffToStored(edited)).toEqual({[optIn.id]: true, [optOut.id]: false});

    // …and the pair round-trips, so what is written is what comes back.
    expect(sorted(weaponsOffFromStored(weaponsOffToStored(edited)))).toEqual(sorted(edited));
  });

  it('a weapon missing from the stored map falls back to its own default', () => {
    // The migration that index lists could not do: a row added since the save is simply absent
    // from the map, so an opt-in weapon starts OFF rather than switching itself on.
    const off = WEAPON_DATABASE.find(w => w.disabled)!;
    const on = WEAPON_DATABASE.find(w => !w.disabled)!;
    const empty = weaponsOffFromStored({}); // a map that has never seen ANY current weapon
    expect(empty.has(off.index)).toBe(true);
    expect(empty.has(on.index)).toBe(false);
    // …and an unknown id in the map (a weapon since renamed or removed) is ignored, not crashed on.
    expect(sorted(weaponsOffFromStored({'no.such.weapon': false}))).toEqual(
      WEAPON_DATABASE.filter(w => w.disabled).map(w => w.index),
    );
  });

  it('a pre-id save (bare index array) is read once and keeps its disabled picks', () => {
    const off = WEAPON_DATABASE.find(w => w.disabled)!;
    const legacy = weaponsOffFromStored([3, 7]);
    expect(legacy.has(3) && legacy.has(7)).toBe(true); // what the player switched off is kept
    expect(legacy.has(off.index)).toBe(true); // and default-off rows it couldn't know about stay off
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
