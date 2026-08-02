/**
 * Guard for `test/_internals.ts`: the soft-private views tests share must still match the engine.
 *
 * These views are reached by cast, so nothing type-checks that (say) `m_tanks` still exists — a
 * rename would leave every test quietly asserting against `undefined` while staying green. This
 * walks the manifests (which the compiler pins to the interfaces) and confirms each member is
 * really present on a live instance.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import {CLand} from '../src/core/CLand';
import {GC_KEYS, LAND_KEYS} from './_internals';

describe('shared test internals stay in sync with the engine', () => {
  it('every GCPriv member exists on a started controller', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(2);
    const missing = Object.keys(GC_KEYS).filter(k => !(k in (gc as unknown as object)));
    expect(missing, 'GCPriv members no longer on CGameController').toEqual([]);
  });

  it('every LandPriv member exists on a generated land', () => {
    const land = new CLand(600, 400);
    land.generateFlat();
    const missing = Object.keys(LAND_KEYS).filter(k => !(k in (land as unknown as object)));
    expect(missing, 'LandPriv members no longer on CLand').toEqual([]);
  });
});
