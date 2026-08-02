/**
 * A weapon/bomb supply crate must resolve to a real weapon, keyed on the stable `id`. Weapons carry
 * an `id` (+ an i18n display name) and never a `.name` field, so a lookup like `w.name === 'Bomb'`
 * returns -1: a bomb crate (≈10% of crates) would grant NOTHING and its pickup text would read
 * "Found Magma Beam", since getWeapon(-1) falls back to weapon 0.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import type {CTank} from '../src/core/CTank';

const BOMB = WEAPON_DATABASE.findIndex(w => w.id === 'bomb');

type Priv = {
  m_crateField: {list(): readonly {kind: string; weaponIndex: number}[]};
  m_tanks: CTank[];
  addCrate(x: number, forced?: string): void;
  collectCrate(c: unknown, tank: CTank): void;
  economyFor(t: CTank): {getOwned(i: number): number};
};

describe('bomb crate', () => {
  it('resolves to the Bomb weapon (not -1) and grants it on pickup', () => {
    expect(BOMB).toBeGreaterThanOrEqual(0); // the Bomb weapon exists in the DB

    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(0);
    gc.startGame(2);
    const p = gc as unknown as Priv;

    p.addCrate(100, 'bomb');
    const crate = p.m_crateField.list().at(-1)!;
    expect(crate.kind).toBe('bomb');
    expect(crate.weaponIndex).toBe(BOMB); // was -1 → mislabeled + no grant

    const bot = p.m_tanks[0];
    const econ = p.economyFor(bot);
    const before = econ.getOwned(BOMB);
    p.collectCrate(crate, bot);
    expect(econ.getOwned(BOMB)).toBe(before + 1); // the taker actually receives the Bomb
  });
});
