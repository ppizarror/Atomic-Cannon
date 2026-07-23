/**
 * Formerly-unwired Settings options (parity fix): each of the nine no-ops now reaches the
 * engine. This drives the real bridge (settingsStore → settingsValues → applyGameSettings →
 * GameConfig) and the Buy-Time / Randomize-Turns behaviour that hangs off it.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {CLand} from '../src/core/CLand';
import {GameConfig} from '../src/core/CGameConfig';
import {setVal} from '../src/ui/settingsStore';
import {applyGameSettings} from '../src/ui/applySettings';

type GCInternals = {m_tanks: CTank[]; endTurn(): void};
const priv = (gc: CGameController) => gc as unknown as GCInternals;

function humanGame(players = 2): CGameController {
  // Deterministic order + open depot for the Buy-Time tests (GameConfig is a shared
  // singleton, so reset what other tests may have left set).
  GameConfig.randomizeTurns = false;
  GameConfig.buyTime = 0;
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(players);
  return gc;
}

describe('Formerly-no-op Settings options', () => {
  it('all nine options now reach GameConfig (were silent no-ops)', () => {
    setVal('gp.rcFires', 0);
    setVal('gfx.smallBuy', 1);
    setVal('tank.relTurrets', 1);
    setVal('tank.bury', 1);
    setVal('gp.utilTurn', 1);
    setVal('gp.randTurns', 1);
    setVal('eco.buyTime', 2);
    setVal('gp.changeWind', 3);
    setVal('gfx.detail', 3);
    setVal('gfx.craterFill', 1);

    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);

    expect(GameConfig.rightClickFires).toBe(false); // rcFires default 1 → 0 disables
    expect(GameConfig.smallBuyFonts).toBe(true);
    expect(GameConfig.relativeTurrets).toBe(true);
    expect(GameConfig.buryTanks).toBe(true);
    expect(GameConfig.utilityTurn).toBe(true);
    expect(GameConfig.randomizeTurns).toBe(true);
    expect(GameConfig.buyTime).toBe(2);
    expect(GameConfig.changeWind).toBe(3);
    expect(GameConfig.detail).toBe(3); // Wargame
    expect(GameConfig.craterFill).toBe(true);

    // Restore every touched key + GameConfig field so nothing leaks to other test files
    // (the settingsStore mock is shared across the suite).
    for (const [k, v] of [
      ['gp.rcFires', 1],
      ['gfx.smallBuy', 0],
      ['tank.relTurrets', 0],
      ['tank.bury', 0],
      ['gp.utilTurn', 0],
      ['gp.randTurns', 0],
      ['eco.buyTime', 0],
      ['gp.changeWind', 0],
      ['gfx.detail', 2],
      ['gfx.craterFill', 0],
    ] as const) {
      setVal(k, v);
    }
    applyGameSettings(gc); // push the restored defaults back into GameConfig
  });

  it('Buy Time gates the depot: Anytime always open, Automatic never', () => {
    const gc = humanGame();
    GameConfig.buyTime = 0; // Anytime
    expect(gc.canOpenDepot()).toBe(true);
    GameConfig.buyTime = 3; // Automatic → weapons auto-assigned, no manual depot
    expect(gc.canOpenDepot()).toBe(false);
    GameConfig.buyTime = 0; // restore
  });

  it('Buy Time "At start" closes the depot after a player has acted', () => {
    const gc = humanGame();
    GameConfig.buyTime = 2; // At-start: buy only before your first turn
    const human = priv(gc).m_tanks.find(t => t.isHuman())!;
    expect(human.canBuy()).toBe(true); // battle start
    priv(gc).endTurn(); // the human takes/forfeits a turn
    expect(human.canBuy()).toBe(false); // depot now closed for them the rest of the battle
    GameConfig.buyTime = 0;
  });

  it('Filled Craters paints the excavated bowl with soil; off leaves it transparent', () => {
    // The carve edits m_pixels/m_material (normally allocated by bake); set them up directly.
    const setup = () => {
      const land = new CLand(400, 300);
      land.generateRandomTerrain(42);
      const p = land as unknown as {
        m_pixels: Uint32Array;
        m_material: Uint8Array;
        m_nWidth: number;
      };
      p.m_pixels = new Uint32Array(400 * 300).fill(0xff112233); // opaque solid ground
      p.m_material = new Uint8Array(400 * 300);
      return {land, px: p.m_pixels, W: p.m_nWidth};
    };
    const cx = 200;
    const sample = (px: Uint32Array, W: number, y: number) => px[Math.floor(y) * W + cx] >>> 24;

    // OFF: the excavated void above the new floor is CLEARED → transparent (background through).
    GameConfig.craterFill = false;
    const off = setup();
    const syOff = off.land.getHeightAt(cx);
    off.land.blastCircle(cx, syOff, 40);
    expect(sample(off.px, off.W, syOff + 5)).toBe(0); // alpha 0 = transparent

    // ON: the same void is filled with opaque soil.
    GameConfig.craterFill = true;
    const on = setup();
    const syOn = on.land.getHeightAt(cx);
    on.land.blastCircle(cx, syOn, 40);
    expect(sample(on.px, on.W, syOn + 5)).toBe(0xff); // alpha 255 = solid soil
    GameConfig.craterFill = false; // restore
  });

  it('Randomize Turns shuffles the queue without dropping any tank', () => {
    GameConfig.randomizeTurns = true; // set BEFORE startGame (humanGame would reset it)
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(4);
    const tanks = priv(gc).m_tanks;
    expect(tanks.length).toBe(4);
    expect(new Set(tanks).size).toBe(4); // order-only shuffle — every tank still present
    expect(tanks.some(t => t.isHuman())).toBe(true); // the human survived the shuffle
    GameConfig.randomizeTurns = false;
  });

  it('Wargame Detail preset renames every CPU "Whopper" (the human keeps their name)', () => {
    GameConfig.detail = 3; // Wargame
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(3); // 1 human + 2 bots
    const tanks = priv(gc).m_tanks;
    const bots = tanks.filter(t => t.isBot());
    expect(bots.length).toBeGreaterThan(0);
    expect(bots.every(t => t.getName() === 'Whopper')).toBe(true);
    expect(tanks.find(t => t.isHuman())!.getName()).not.toBe('Whopper');
    GameConfig.detail = 2; // restore (default High)
  });
});
