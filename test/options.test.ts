/**
 * Formerly-unwired Settings options (parity fix): each of the nine no-ops now reaches the
 * engine. This drives the real bridge (settingsStore → settingsValues → applyGameSettings →
 * GameConfig) and the Buy-Time / Randomize-Turns behaviour that hangs off it.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {CLand} from '../src/core/CLand';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {weaponEnabled} from '../src/core/CGameContent';
import {setVal} from '../src/ui/settingsStore';
import {applyGameSettings} from '../src/ui/applySettings';

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

  it('Radiation Damage defaults ON and reaches GameConfig (OFF = legacy cosmetic)', () => {
    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    expect(GameConfig.radiationDamage).toBe(true); // catalog default 1 → ON (port interpretation)

    setVal('gp.radiationDamage', 0); // legacy: fallout is cosmetic, no DOT
    applyGameSettings(gc);
    expect(GameConfig.radiationDamage).toBe(false);

    setVal('gp.radiationDamage', 1); // restore (shared settings mock)
    applyGameSettings(gc);
  });

  it('Radiation Damage ON drains a tank standing on fallout; OFF does not (legacy cosmetic)', () => {
    const run = (on: boolean): {before: number; after: number} => {
      const gc = humanGame(2);
      GameConfig.radiationDamage = on; // set AFTER startGame so nothing resets it under us
      const p = gc as unknown as {m_tanks: CTank[]; m_land: CLand};
      const tank = p.m_tanks[0];
      const x = Math.floor(tank.getPosition().x);
      const surf = p.m_land.getHeightAt(x);
      const before = tank.getHealth().nLife;
      // Irradiate directly under the tank (modest DOT so it hurts without killing).
      p.m_land.blastIradiate(x, surf, 70, 120, 6, [80, 255, 80]);
      for (let i = 0; i < 180; i++) gc.update(1 / 60); // specks settle onto its column, then DOT ticks
      return {before, after: tank.getHealth().nLife};
    };

    const onR = run(true);
    expect(onR.after).toBeLessThan(onR.before); // "green = danger": fallout under the tank drained it

    const offR = run(false);
    expect(offR.after).toBe(offR.before); // legacy: fallout is purely cosmetic, no tank damage

    GameConfig.radiationDamage = true; // restore default
  });

  it("the weapon list shows the ACTIVE player's own stock, not the full arsenal", () => {
    const gc = humanGame(2);
    const p = gc as unknown as {
      m_tanks: CTank[];
      m_currentPlayerIndex: number;
      economyFor(t: CTank): {grant(i: number): void; hasStock(i: number): boolean};
    };
    const botIdx = p.m_tanks.findIndex(t => !t.isHuman());
    expect(botIdx).toBeGreaterThanOrEqual(0);
    p.m_currentPlayerIndex = botIdx; // spectate the bot's turn
    const econ = p.economyFor(p.m_tanks[botIdx]);

    // A weapon the bot does NOT own must be ABSENT (previously the whole arsenal was shown).
    const missing = WEAPON_DATABASE.find(w => weaponEnabled(w.index) && !econ.hasStock(w.index));
    expect(missing).toBeDefined();
    const has = () => gc.getWeaponDefs().some(w => w.index === missing!.index);
    expect(has()).toBe(false); // not shown — the bot doesn't own it

    const before = gc.getWeaponDefs().length;
    econ.grant(missing!.index); // give it to the bot → the list tracks its real inventory
    expect(has()).toBe(true);
    expect(gc.getWeaponDefs().length).toBe(before + 1);
  });

  it('the arsenal numbers by BUY ORDER: Shell stays #1, bought weapons follow in acquisition order', () => {
    const gc = humanGame(2);
    const p = gc as unknown as {
      m_tanks: CTank[];
      m_currentPlayerIndex: number;
      economyFor(t: CTank): {grant(i: number): void};
    };
    const humanIdx = p.m_tanks.findIndex(t => t.isHuman());
    p.m_currentPlayerIndex = humanIdx; // getWeaponDefs reads the ACTIVE tank's economy
    const econ = p.economyFor(p.m_tanks[humanIdx]);

    const staple = WEAPON_DATABASE.findIndex(w => w.id === 'shell');
    // Two enabled non-staple weapons, one with a HIGHER database index than the other.
    const others = WEAPON_DATABASE.filter(w => w.index !== staple && weaponEnabled(w.index)).map(
      w => w.index,
    );
    const wHi = others[others.length - 1];
    const wLo = others[0];
    expect(wHi).toBeGreaterThan(wLo); // db order alone would put wLo first

    econ.grant(wHi); // bought FIRST (higher db index)
    econ.grant(wLo); // bought SECOND (lower db index)

    const defs = gc.getWeaponDefs().map(d => d.index);
    expect(defs[0]).toBe(staple); // the Shell keeps position 1
    const iHi = defs.indexOf(wHi);
    const iLo = defs.indexOf(wLo);
    expect(iHi).toBeGreaterThan(0); // after the staple
    expect(iLo).toBeGreaterThan(iHi); // bought later → later in the list, despite its LOWER db index
  });

  it('Instant camera snaps to the active tank at turn-begin when it is off-screen (large maps)', () => {
    GameConfig.landSize = 5; // wide world → the two tanks are off-screen from each other
    GameConfig.cameraMode = 1; // Instant (Graphics → Camera): the off-screen snap is Instant-mode now
    const gc = humanGame(2);
    GameConfig.landSize = 3; // restore for other tests (world already built at 5)
    const p = gc as unknown as {
      m_tanks: CTank[];
      m_currentPlayerIndex: number;
      m_viewW: number;
      beginTurn(): void;
    };

    // Battle start centred the camera on player 0; find a tank currently OFF-SCREEN.
    const cam = gc.getCameraX();
    const farIdx = p.m_tanks.findIndex(t => {
      const x = t.getPosition().x;
      return x < cam || x > cam + p.m_viewW;
    });
    expect(farIdx).toBeGreaterThanOrEqual(0); // a big map DOES place a tank off-screen

    p.m_currentPlayerIndex = farIdx;
    p.beginTurn(); // its turn begins → camera must snap so the player can see it
    const focusX = p.m_tanks[farIdx].getPosition().x;
    const after = gc.getCameraX();
    expect(focusX).toBeGreaterThanOrEqual(after); // the once-off-screen tank is now visible
    expect(focusX).toBeLessThanOrEqual(after + p.m_viewW);
    GameConfig.cameraMode = 0; // restore the Smooth default for other tests
  });

  it('a tank falls into a crater carved under it, and respects the Bury Tanks setting', () => {
    const W = 1200,
      H = 500,
      SURF = 300;
    const build = (): CLand => {
      const land = new CLand(W, H) as unknown as {
        generateFlat(): void;
        m_arrHeights: Int16Array;
        m_pixels: Uint32Array;
        m_material: Uint8Array;
      };
      land.generateFlat();
      land.m_pixels = new Uint32Array(W * H);
      land.m_material = new Uint8Array(W * H);
      for (let x = 0; x < W; x++) {
        land.m_arrHeights[x] = SURF;
        for (let y = SURF; y < H; y++) land.m_pixels[y * W + x] = 0xff3c5a1e >>> 0;
      }
      return land as unknown as CLand;
    };
    const settled = (land: CLand): CTank => {
      const t = new CTank('T', 0);
      (t as unknown as {init(x: number, l: CLand): void}).init(600, land);
      for (let i = 0; i < 60; i++) t.update(land, 1 / 60);
      return t;
    };

    // Carve a crater directly under the tank → it drops onto the new, lower surface.
    const land = build();
    const tank = settled(land);
    const yStart = tank.getPosition().y;
    land.carveDiscCollapse(600, SURF, 90, true, true, true);
    for (let i = 0; i < 300; i++) {
      land.update(1 / 60);
      tank.update(land, 1 / 60);
    }
    expect(tank.getPosition().y).toBeGreaterThan(yStart + 10); // it FELL into the crater

    // Pile dirt over a tank: Bury OFF lifts it back to the surface; Bury ON leaves it buried.
    const pile = (bury: boolean): number => {
      GameConfig.buryTanks = bury;
      const l = build();
      const t = settled(l);
      const before = t.getPosition().y;
      const pv = l as unknown as {m_arrHeights: Int16Array};
      for (let c = 560; c < 640; c++) pv.m_arrHeights[c] = SURF - 40; // 40px of dirt on top
      for (let i = 0; i < 200; i++) t.update(l, 1 / 60);
      return t.getPosition().y - before;
    };
    expect(pile(false)).toBeLessThan(-10); // Bury OFF: lifted up out of the dirt (smaller y)
    expect(Math.abs(pile(true))).toBeLessThan(2); // Bury ON: stays put, buried
    GameConfig.buryTanks = false; // restore
  });

  it('a Move drives the tank all the way to its target over spiky terrain (no steepness gate)', () => {
    // Every random terrain must let the tank crawl the full distance — the original drives on ANY
    // terrain; a per-column slope gate used to halt it on ordinary bumps after a few frames.
    for (const seed of [1, 123, 999, 55, 314]) {
      const land = new CLand(2000, 500);
      land.generateRandomTerrain(seed);
      const tank = new CTank('T', 0);
      (tank as unknown as {init(x: number, l: CLand): void}).init(800, land);
      for (let i = 0; i < 60; i++) tank.update(land, 1 / 60);
      const x0 = tank.getPosition().x;
      tank.startDrive(x0 + 150);
      for (let f = 0; f < 3000 && tank.isMoving(); f++) tank.update(land, 1 / 60);
      expect(Math.abs(tank.getPosition().x - (x0 + 150))).toBeLessThan(2); // reached the target
    }
  });

  it('a BURIED tank cannot drive or fly (only being buried blocks it)', () => {
    const W = 800,
      H = 400,
      SURF = 250;
    const land = new CLand(W, H) as unknown as {
      generateFlat(): void;
      m_arrHeights: Int16Array;
      m_pixels: Uint32Array;
      m_material: Uint8Array;
    };
    land.generateFlat();
    land.m_pixels = new Uint32Array(W * H);
    land.m_material = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      land.m_arrHeights[x] = SURF;
      for (let y = SURF; y < H; y++) land.m_pixels[y * W + x] = 0xff3c5a1e >>> 0;
    }
    const L = land as unknown as CLand;
    const tank = new CTank('T', 0);
    (tank as unknown as {init(x: number, l: CLand): void}).init(400, L);
    for (let i = 0; i < 60; i++) tank.update(L, 1 / 60);
    GameConfig.buryTanks = true;

    // A LIGHT dusting of ejecta (8px, the hull still sticks well out) is NOT "underground" — the
    // reported bug was that any speck of ejecta tripped the condition (old 0.5px / 10px thresholds).
    for (let c = 360; c < 440; c++) (land.m_arrHeights as Int16Array)[c] = SURF - 8;
    tank.update(L, 1 / 60);
    expect(tank.isBuried()).toBe(false); // a few px of ejecta ≠ underground
    expect(tank.canMove(L)).toBe(true);

    // Bury it FULLY: pile 40px of dirt (> the 24px hull) so the surface rises above the tank's top.
    for (let c = 360; c < 440; c++) (land.m_arrHeights as Int16Array)[c] = SURF - 40;
    tank.update(L, 1 / 60); // recompute the buried flag against the new (higher) surface
    expect(tank.isBuried()).toBe(true);
    expect(tank.canMove(L)).toBe(false);

    // Drive is refused while buried.
    const x0 = tank.getPosition().x;
    tank.startDrive(x0 + 100);
    expect(tank.isMoving()).toBe(false);
    for (let i = 0; i < 60; i++) tank.update(L, 1 / 60);
    expect(Math.abs(tank.getPosition().x - x0)).toBeLessThan(1); // never moved

    // Jet ignition is refused while buried.
    expect(tank.igniteJet(5)).toBe(false);
    expect(tank.isThrustingUp()).toBe(false);

    // Dig it out (lower the ground back) → it can drive again.
    for (let c = 360; c < 440; c++) (land.m_arrHeights as Int16Array)[c] = SURF;
    tank.update(L, 1 / 60);
    expect(tank.isBuried()).toBe(false);
    tank.startDrive(x0 + 100);
    expect(tank.isMoving()).toBe(true); // free now
    GameConfig.buryTanks = false; // restore
  });

  it('a destroyed wreck falls into a crater carved under it (not left floating)', () => {
    const gc = humanGame(4); // 4 teams → killing one leaves the battle running (no BattleEnd)
    const p = gc as unknown as {m_tanks: CTank[]; m_land: CLand};
    const wreck = p.m_tanks[1] as unknown as CTank & {m_bIsAlive: boolean; m_bExploded: boolean};
    wreck.m_bIsAlive = false; // a destroyed tank...
    wreck.m_bExploded = true; // ...that leaves a drawn wreck
    const yBefore = wreck.getPosition().y;
    const wx = Math.floor(wreck.getPosition().x);
    // Blow the ground out from under the wreck.
    p.m_land.carveDiscCollapse(wx, p.m_land.getHeightAt(wx), 100, true, true, true);
    for (let i = 0; i < 240; i++) gc.update(1 / 60);
    expect(wreck.getPosition().y).toBeGreaterThan(yBefore + 10); // the wreck fell (was left floating)
  });

  it('a tank that dies still owning a Death weapon (Burial Mound) cooks it off — heaps earth', () => {
    const burial = WEAPON_DATABASE.findIndex(w => w.id === 'burial.mound');
    expect(burial).toBeGreaterThanOrEqual(0);
    type GCPriv = {
      m_tanks: CTank[];
      m_land: CLand;
      economyFor(t: CTank): {grant(i: number): void};
      handleTankDestroyed(t: CTank): void;
    };
    const kill = (owns: boolean): number => {
      const p = humanGame(4) as unknown as GCPriv; // 4 teams → no BattleEnd when one dies
      const victim = p.m_tanks[1] as unknown as CTank & {m_bIsAlive: boolean; m_bExploded: boolean};
      if (owns) p.economyFor(victim).grant(burial); // still holds a Burial Mound on death
      const x = Math.floor(victim.getPosition().x);
      const before = p.m_land.getHeightAt(x);
      victim.m_bIsAlive = false;
      victim.m_bExploded = true;
      p.handleTankDestroyed(victim); // → posthumous Death-weapon cook-off
      for (let i = 0; i < 300; i++) p.m_land.update(1 / 60); // settle the thrown dirt into a mound
      return before - p.m_land.getHeightAt(x); // >0 = surface ROSE (Y smaller = higher)
    };

    expect(kill(true)).toBeGreaterThan(8); // Burial Mound raised the ground over the corpse
    expect(Math.abs(kill(false))).toBeLessThan(3); // no Death weapon → no mound
  });

  it('a Move turn ends only when the tank STOPS — a long move is not cut short mid-drive', () => {
    GameConfig.landSize = 5; // wide world so a long move fits
    const gc = humanGame(2);
    GameConfig.landSize = 3; // restore (world already built at 5)
    const p = gc as unknown as {
      m_tanks: CTank[];
      m_currentPlayerIndex: number;
      m_land: CLand;
      startTankMove(t: CTank, destX: number): void;
    };
    const mover = p.m_tanks[0];
    p.m_currentPlayerIndex = 0;
    const startX = mover.getPosition().x;
    const w = p.m_land.width;
    // A LONG move (~700px ≈ 10s at 70 px/s), toward the roomier side — well past the OLD 5s cap.
    const dest = startX < w / 2 ? Math.min(w - 30, startX + 700) : Math.max(30, startX - 700);
    expect(Math.abs(dest - startX)).toBeGreaterThan(450); // genuinely long
    p.startTankMove(mover, dest);
    expect(mover.isMoving()).toBe(true);

    // Advance ~6.5s of sim — the OLD 5s cap would have ended the turn here, mid-drive, letting the
    // next tank fire while this one was still moving.
    for (let i = 0; i < Math.round(6.5 * 60); i++) gc.update(1 / 60);
    expect(mover.isMoving()).toBe(true); // STILL driving — the long move wasn't cut short
    expect(p.m_currentPlayerIndex).toBe(0); // still the mover's turn (no hand-off mid-move)

    // Let it reach the target → it stops, and only THEN the turn hands off.
    for (let i = 0; i < 600 && mover.isMoving(); i++) gc.update(1 / 60);
    expect(mover.isMoving()).toBe(false);
  });

  it('a supply crate rolls ONCE per round, not once per turn', () => {
    const gc = humanGame(2); // 2 players → 2 turns per round
    const prev = GameConfig.crateChance;
    GameConfig.crateChance = 100; // always drops WHEN it actually rolls
    const p = gc as unknown as {m_crateField: {list(): readonly unknown[]}; endTurn(): void};

    expect(p.m_crateField.list().length).toBe(0);
    p.endTurn(); // player 0 → 1: mid-round hand-off (turn order NOT wrapped yet)
    expect(p.m_crateField.list().length).toBe(0); // no crate mid-round — the bug dropped one EVERY turn
    p.endTurn(); // player 1 → 0: the round wraps
    expect(p.m_crateField.list().length).toBe(1); // exactly one crate for the completed round

    GameConfig.crateChance = prev; // restore (shared singleton)
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

  it('Filled Craters is a render toggle (darkened-backdrop layer); a carve still works either way', () => {
    // Filled Craters is now a rendering feature: a DARKENED snapshot of the pristine terrain drawn
    // BEHIND the live terrain, so carved-away regions reveal the mountain's darkened interior (not
    // sky). It is decoupled from the carve — the crater math is identical whether the option is on or
    // off (only the draw layers differ, verified in-game). Here we just pin that the toggle is a plain
    // boolean and that a crater carves regardless (no per-column pixel fill in the carve anymore).
    const carveWith = (fill: boolean): number => {
      GameConfig.craterFill = fill;
      const land = new CLand(400, 300);
      land.generateRandomTerrain(42);
      const cx = 200;
      const sy = land.getHeightAt(cx);
      land.carveDiscCollapse(cx, sy, 40);
      return land.getHeightAt(cx) - sy; // how much the surface dropped
    };
    expect(carveWith(false)).toBeGreaterThan(0); // carves with the option OFF
    expect(carveWith(true)).toBeGreaterThan(0); // …and ON — the carve is option-independent
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
