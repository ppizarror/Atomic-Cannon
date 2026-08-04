/**
 * The Weapons Depot's column sort is a per-WAR preference. The panel unmounts every time the depot
 * closes (see DepotPanel), so the active column + direction are held in the store instead of
 * component state — sorting by Power, closing, and reopening (next turn, next battle) must still
 * show Power-sorted rows. Quitting to the menu ends the war and restores the default (cost, asc).
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameType} from '../src/game/CGameController';
import type {CAudio} from '../src/audio/CAudio';
import {Roster} from '../src/core/CRoster';

const fakeAudio = (): CAudio => new Proxy({}, {get: () => () => undefined}) as unknown as CAudio;

function newGame(): CGameController {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setAudio(fakeAudio());
  gc.setGameType(EGameType.Deathmatch);
  gc.startGame(2);
  return gc;
}

describe('Depot sort persistence', () => {
  beforeEach(async () => {
    const {depotSort} = await import('../src/ui/store');
    depotSort.value = {key: 'cost', dir: 1};
  });

  it('opens on cost ascending, toggles the active column, and switches columns ascending-first', async () => {
    const {depotSort, depotSortBy} = await import('../src/ui/store');
    expect(depotSort.value).toEqual({key: 'cost', dir: 1});

    depotSortBy('cost'); // same column → flip direction
    expect(depotSort.value).toEqual({key: 'cost', dir: -1});

    depotSortBy('power'); // a NEW column always starts ascending
    expect(depotSort.value).toEqual({key: 'power', dir: 1});
    depotSortBy('power');
    expect(depotSort.value).toEqual({key: 'power', dir: -1});
  });

  it('survives closing and reopening the depot (the regression: it used to reset every open)', async () => {
    const {depotSort, depotSortBy, openDepot, closeDepot, setController, showDepot} = await import('../src/ui/store');
    setController(newGame());

    openDepot();
    expect(showDepot.value).toBe(true);
    depotSortBy('name');
    closeDepot();
    expect(showDepot.value).toBe(false);

    openDepot(); // …a later turn, or the next battle of the same war
    expect(depotSort.value).toEqual({key: 'name', dir: 1});
  });

  it('resets to the default when the war ends (quit to the menu)', async () => {
    const {depotSort, depotSortBy, quitToMenu, setController, screen} = await import('../src/ui/store');
    setController(newGame());
    screen.value = 'battle';

    depotSortBy('qty');
    expect(depotSort.value).toEqual({key: 'qty', dir: 1});

    quitToMenu();
    expect(depotSort.value).toEqual({key: 'cost', dir: 1}); // a fresh war opens sorted as usual
  });
});
