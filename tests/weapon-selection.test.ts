/**
 * Weapon-selection integrity: each tank keeps its OWN weapon, a bot's pick never
 * clobbers the human's, and the control-weapon lock only restricts the human.
 *
 * These checks share one game instance and run in sequence — each step builds on
 * the state the previous one left behind.
 */
import {describe, it, expect, vi} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {getWeapon, WEAPON_DATABASE, weaponName} from '../src/core/CWeapon';

const SHELL = WEAPON_DATABASE.findIndex(w => weaponName(w) === 'Shell');

// Standalone accessor view (see ai-integration.test.ts): intersecting the class,
// which has private members, would collapse the type to `never`.
type GC = {
  startGame(numTanks: number): void;
  getCurrentWeaponIndex(): number;
  getWeaponDefs(): {id: string}[];
  selectWeapon(index: number): void;
  m_tanks: {getWeaponIndex(): number; isHuman(): boolean; isBot(): boolean}[];
  m_currentPlayerIndex: number;
  beginTurn(): void;
  executeBotTurn(): void;
};

const gc = new CGameController(makeCanvas()) as unknown as GC;
gc.startGame(2); // player 0 = human, player 1 = bot
const human = gc.m_tanks[0],
  bot = gc.m_tanks[1];

// The human starts on whatever weapon the control lock is set to — derive it
// rather than hardcoding, so the test survives changing the FX-test control weapon.
const CTRL = human.getWeaponIndex();
const CTRL_NAME = weaponName(WEAPON_DATABASE[CTRL]);

describe('Weapon selection', () => {
  it(`human starts on the control weapon (${CTRL_NAME}), stored on its own tank`, () => {
    expect(gc.getCurrentWeaponIndex()).toBe(CTRL);
    expect(human.getWeaponIndex()).toBe(CTRL);
  });

  it('human weapon list reflects the control lock', () => {
    // A pinned control weapon → the list is just that weapon; otherwise it's the
    // full arsenal (which always contains whatever the human currently holds).
    const defs = gc.getWeaponDefs();
    const locked = defs.length === 1;
    expect(
      locked ? weaponName(defs[0]) === CTRL_NAME : defs.some(d => weaponName(d) === CTRL_NAME),
    ).toBe(true);
  });

  it('selectWeapon persists onto the acting tank', () => {
    gc.selectWeapon(SHELL);
    expect(gc.getCurrentWeaponIndex()).toBe(SHELL);
    expect(human.getWeaponIndex()).toBe(SHELL);
    gc.selectWeapon(CTRL); // restore for the persistence checks below
  });

  it('a bot pick does NOT clobber the human weapon', () => {
    gc.m_currentPlayerIndex = 1; // hand the turn to the bot
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99); // >BOT_MOVE_CHANCE → aims/picks
    gc.executeBotTurn(); // bot picks a weapon (and fires)
    rnd.mockRestore();
    expect(typeof bot.getWeaponIndex()).toBe('number');
    expect(human.getWeaponIndex()).toBe(CTRL);
  });

  it("bot turn shows the BOT's own stock, not the full arsenal", () => {
    gc.m_currentPlayerIndex = 1; // the bot's turn
    const defs = gc.getWeaponDefs();
    // Spectating the bot shows only what it actually owns — far fewer than the whole database
    // (this is the fix for "the enemy list shows nukes it doesn't have").
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.length).toBeLessThan(WEAPON_DATABASE.length);
  });

  it('human weapon is restored on their turn', () => {
    gc.m_currentPlayerIndex = 0;
    gc.beginTurn();
    expect(gc.getCurrentWeaponIndex()).toBe(CTRL);
    expect(getWeapon(gc.getCurrentWeaponIndex()).getType()).toBe(WEAPON_DATABASE[CTRL].type);
  });

  it('tanks hold independent weapons at the same time', () => {
    expect(human.getWeaponIndex()).toBe(CTRL);
    expect(typeof bot.getWeaponIndex()).toBe('number');
  });
});
