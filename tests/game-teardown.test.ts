/**
 * Quitting a battle to the main menu must TEAR THE BATTLE DOWN — not merely freeze it. Regression:
 * closing to the menu left `isStarted()` true, so the render loop kept advancing the sim (two AIs
 * "still playing" behind the menu) and the last frame lingered instead of the scene going blank.
 * stopGame() flips isStarted() → false so the sim/redraw/HUD all short-circuit like the boot title
 * screen, and goToMenu()/quitToMenu() call it.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameType} from '../src/game/CGameController';
import type {CAudio} from '../src/audio/CAudio';
import {Roster} from '../src/core/CRoster';

// A no-op audio facade — every method is a silent counter so the controller can drive it headless.
const fakeAudio = (): CAudio => new Proxy({}, {get: () => () => undefined}) as unknown as CAudio;

function newGame(): CGameController {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setAudio(fakeAudio());
  gc.setGameType(EGameType.Deathmatch);
  gc.setTotalBattles(5);
  gc.startGame(2);
  return gc;
}

describe('Battle teardown', () => {
  it('stopGame() ends the match: isStarted() false, nothing redraws, the sim no longer advances', () => {
    const gc = newGame();
    expect(gc.isStarted()).toBe(true);

    gc.stopGame();
    expect(gc.isStarted()).toBe(false);
    expect(gc.shouldRedraw()).toBe(false); // no redraw → no animation on the menu backdrop

    // advance() must be inert now — the sim can't keep running (the reported "tanks still playing").
    const state = gc.getState();
    for (let i = 0; i < 120; i++) gc.advance(0.1); // ~12 s of wall-clock time
    expect(gc.isStarted()).toBe(false);
    expect(gc.getState()).toBe(state);
  });

  it('stopGame() is idempotent (no-op when no battle is running, e.g. the boot menu)', () => {
    const gc = new CGameController(makeCanvas());
    expect(gc.isStarted()).toBe(false);
    expect(() => gc.stopGame()).not.toThrow();
    expect(gc.isStarted()).toBe(false);
  });
});

describe('Quit to menu (store)', () => {
  it('quitToMenu() tears the battle down so it can not keep playing behind the menu', async () => {
    const {setController, quitToMenu, screen} = await import('../src/ui/store');
    const gc = newGame();
    setController(gc);
    screen.value = 'battle';
    expect(gc.isStarted()).toBe(true);

    quitToMenu();
    expect(screen.value).toBe('menu');
    expect(gc.isStarted()).toBe(false); // torn down — advance() (render loop) is now a no-op
  });
});
