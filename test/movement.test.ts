/**
 * Deterministic tests for the tank ground-drive (bot repositioning): it crawls to a
 * destination on flat ground, climbs ANY terrain (the original has no steepness gate),
 * and clamps at the map edge.
 */
import {describe, it, expect, vi} from 'vitest';
import {makeCanvas} from './_dom';

import {CTank} from '../src/core/CTank';
import type {CLand} from '../src/core/CLand';
import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {Vec2} from '../src/math/Vec2';

// Minimal land stand-ins (only what CTank.update touches).
const flat = (): CLand =>
  ({
    width: 900,
    height: 600,
    getHeightAt: () => 500,
    getNormal: () => new Vec2(0, -1),
  }) as unknown as CLand;
const wall = (): CLand =>
  ({
    width: 900,
    height: 600,
    getHeightAt: (x: number) => (x > 300 ? 300 : 500),
    getNormal: () => new Vec2(0, -1),
  }) as unknown as CLand;

// Drive a tank to rest (or a step cap).
function driveToRest(t: CTank, land: CLand, maxSteps = 1200) {
  for (let i = 0; i < maxSteps && t.isMoving(); i++) t.update(land, 1 / 30);
}

describe('Tank ground-drive', () => {
  it('crawls to the destination on flat ground and stops there', () => {
    const land = flat();
    const t = new CTank('X', 0);
    t.init(200, land);
    t.startDrive(400);
    expect(t.isMoving() && t.isDriving()).toBe(true); // isMoving right after startDrive
    driveToRest(t, land);
    expect(Math.abs(t.getPosition().x - 400) < 2).toBe(true); // reaches the destination
    expect(!t.isMoving() && !t.isDriving()).toBe(true); // settles (not moving)
  });

  it('drives left too', () => {
    const land = flat();
    const t = new CTank('X', 0);
    t.init(600, land);
    t.startDrive(350);
    driveToRest(t, land);
    expect(Math.abs(t.getPosition().x - 350) < 2).toBe(true); // reaches a leftward destination
  });

  it('climbs a steep wall and reaches the destination (drives on ANY terrain)', () => {
    const land = wall(); // a 200px step up at x>300
    const t = new CTank('X', 0);
    t.init(200, land);
    t.startDrive(600); // target is past the wall at x>300
    driveToRest(t, land);
    // The original crawls over any terrain — no steepness gate stops it before the wall.
    expect(Math.abs(t.getPosition().x - 600) < 2).toBe(true); // climbs the wall, reaches the target
    expect(t.isMoving()).toBe(false); // settles
  });

  it('clamps at the battlefield edge', () => {
    const land = flat();
    const t = new CTank('X', 0);
    t.init(60, land);
    t.startDrive(-500); // off the left edge
    driveToRest(t, land);
    expect(t.getPosition().x >= 16 && t.getPosition().x < 60 && !t.isMoving()).toBe(true); // stops at/inside the left edge
  });

  it('stopMoving() cancels a drive', () => {
    const land = flat();
    const t = new CTank('X', 0);
    t.init(200, land);
    t.startDrive(800);
    t.update(land, 1 / 30);
    t.stopMoving();
    expect(!t.isDriving() && !t.isMoving()).toBe(true); // stopMoving cancels the drive
  });

  it("a bot's turn is MOVE or FIRE (mutually exclusive)", () => {
    // In-game: a bot's turn is MOVE or FIRE (mutually exclusive). A Move utility
    // drives the tank and ends the turn WITHOUT firing; otherwise it fires and does
    // not move. (Random maps: a bot can spawn boxed in, so "moved" is a majority.)

    // Standalone accessor view (see ai-integration.test.ts): intersecting the class,
    // which has private members, would collapse the type to `never`.
    type GC = {
      startGame(numTanks: number): void;
      setDifficulty(level: number): void;
      getShotCount(): number;
      update(dt: number): void;
      m_tanks: CTank[];
      m_currentPlayerIndex: number;
      executeBotTurn(): void;
    };
    const RUNS = 6;
    const run = (roll: number) => {
      const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
      gc.startGame(2);
      gc.setDifficulty(5);
      gc.m_currentPlayerIndex = 1;
      const bot = gc.m_tanks[1];
      const x0 = bot.getPosition().x;
      const rnd = vi.spyOn(Math, 'random').mockReturnValue(roll);
      gc.executeBotTurn();
      // Pump the sim: a firing bot resolves quickly (breaks on the shot); a moving bot
      // never fires, so it runs the full window (plenty for the drive to settle).
      for (let i = 0; i < 240 && gc.getShotCount() === 0; i++) gc.update(1 / 30);
      rnd.mockRestore();
      return {moved: Math.abs(bot.getPosition().x - x0) > 5, fired: gc.getShotCount() > 0};
    };

    // Forced MOVE (roll < BOT_MOVE_CHANCE): drives, ends the turn, never fires.
    let moved = 0,
      movedFired = 0;
    for (let r = 0; r < RUNS; r++) {
      const o = run(0.1);
      if (o.moved) moved++;
      if (o.fired) movedFired++;
    }
    expect(moved >= RUNS - 2).toBe(true); // a moving bot actually moves
    expect(movedFired).toBe(0); // a moving bot does NOT fire

    // Forced FIRE (roll > BOT_MOVE_CHANCE): fires, never drives.
    let fired = 0,
      firedMoved = 0;
    for (let r = 0; r < RUNS; r++) {
      const o = run(0.99);
      if (o.fired) fired++;
      if (o.moved) firedMoved++;
    }
    expect(fired).toBe(RUNS); // a firing bot fires
    expect(firedMoved).toBe(0); // a firing bot does NOT move
  });

  it('human Move: FIRE arms click-to-place; the tank moves only when a spot is clicked', () => {
    type GC = {
      startGame(n: number): void;
      setStartCredits(n: number): void;
      setHumanCount(n: number): void;
      buyWeapon(i: number): boolean;
      selectWeapon(i: number): void;
      fire(): void;
      isMovePlacing(): boolean;
      placeMove(wx: number): void;
      canAct(): boolean;
      beginAim(wx: number, wy: number): boolean;
      m_tanks: CTank[];
      m_currentPlayerIndex: number;
    };
    const gc = new CGameController(makeCanvas(900, 600)) as unknown as GC;
    gc.setStartCredits(100_000);
    gc.setHumanCount(1);
    gc.startGame(2);
    gc.m_currentPlayerIndex = 0;
    const human = gc.m_tanks[0];
    const moveIdx = WEAPON_DATABASE.findIndex(w => w.id === 'move.mid');
    expect(gc.buyWeapon(moveIdx)).toBe(true); // stock a Move utility
    gc.selectWeapon(moveIdx);

    const x0 = human.getPosition().x;
    gc.fire(); // arms placement — must NOT drive yet
    expect(gc.isMovePlacing()).toBe(true);
    expect(human.isMoving()).toBe(false); // FIRE alone doesn't move the tank

    // Selecting another weapon disarms a pending placement (no accidental move).
    gc.selectWeapon(WEAPON_DATABASE.findIndex(w => w.id === 'shell'));
    expect(gc.isMovePlacing()).toBe(false);
    expect(human.isMoving()).toBe(false); // still hasn't moved

    // Re-arm and place: a click within the budget drives the tank there.
    gc.selectWeapon(moveIdx);
    gc.fire();
    expect(gc.isMovePlacing()).toBe(true);
    gc.placeMove(x0 + 40); // click a spot 40px right, within the move budget
    expect(gc.isMovePlacing()).toBe(false); // placement consumed
    expect(human.isMoving()).toBe(true); // now driving toward the clicked destination

    // While the drive is under way, ALL player input is locked (same as jet flight): the HUD/aim
    // gate closes and aim clicks are ignored, so FIRE does nothing until the tank settles.
    expect(gc.canAct()).toBe(false);
    expect(gc.beginAim(x0 + 100, 400)).toBe(false);
  });
});
