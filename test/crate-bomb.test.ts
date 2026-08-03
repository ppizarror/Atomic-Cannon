/**
 * A bomb crate is a TRAP, not a prize: the original (crate type 3) resolves the weapon named
 * "Bomb" and detonates it on whoever opened the crate, paying out nothing. Two things must hold.
 *
 *  1. The crate still resolves to a REAL weapon index, not -1. Weapons carry a stable `id` (+ an
 *     i18n display name) and never a `.name` field, so a lookup like `w.name === 'Bomb'` returns
 *     -1 and `getWeapon(-1)` falls back to weapon 0 — the trap would cook off a Magma Beam.
 *  2. Opening one HURTS and grants nothing. This port used to hand the Bomb over as a free weapon
 *     (sharing the 'weapon' branch), which made a trap into a reward — while CBotUltraAI already
 *     refused to grab one, so bots declined a prize and humans collected a free weapon.
 *
 * The damage is deliberately picker-only: the original hits just the opener, with no falloff and no
 * kickback, so a bystander sitting on the crate is untouched.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import type {CTank} from '../src/core/CTank';

const BOMB = WEAPON_DATABASE.findIndex(w => w.id === 'bomb');

/** The live crate record — `list()` hands back the field's own array, so x/y are mutable here. */
type TestCrate = {kind: string; weaponIndex: number; x: number; y: number};

type Priv = {
  m_crateField: {list(): readonly TestCrate[]};
  m_tanks: CTank[];
  addCrate(x: number, forced?: string): void;
  collectCrate(c: unknown, tank: CTank): void;
  economyFor(t: CTank): {getOwned(i: number): number};
};

function startMatch(): Priv {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(0);
  gc.startGame(2);
  return gc as unknown as Priv;
}

describe('bomb crate', () => {
  it('resolves to the Bomb weapon, not -1', () => {
    expect(BOMB).toBeGreaterThanOrEqual(0); // the Bomb weapon exists in the DB

    const p = startMatch();
    p.addCrate(100, 'bomb');
    const crate = p.m_crateField.list().at(-1)!;
    expect(crate.kind).toBe('bomb');
    expect(crate.weaponIndex).toBe(BOMB); // was -1 → the trap would cook off weapon 0
  });

  it('detonates on the taker instead of granting a weapon', () => {
    const p = startMatch();
    p.addCrate(100, 'bomb');
    const crate = p.m_crateField.list().at(-1)!;

    const bot = p.m_tanks[0];
    const econ = p.economyFor(bot);
    const ownedBefore = econ.getOwned(BOMB);
    const lifeBefore = bot.getHealth().nLife;

    p.collectCrate(crate, bot);

    expect(econ.getOwned(BOMB)).toBe(ownedBefore); // no free weapon — it is a trap
    expect(bot.getHealth().nLife).toBeLessThan(lifeBefore); // and it cost the taker life
  });

  it('hurts only the taker, not a bystander sitting on the crate', () => {
    const p = startMatch();
    const [taker, bystander] = p.m_tanks;

    // Put the crate right on the bystander: an area blast would catch it, a picker-only hit won't.
    const at = bystander.getPosition();
    p.addCrate(at.x, 'bomb');
    const crate = p.m_crateField.list().at(-1)!;
    crate.y = at.y;

    const takerBefore = taker.getHealth().nLife;
    const bystanderBefore = bystander.getHealth().nLife;

    p.collectCrate(crate, taker);

    expect(taker.getHealth().nLife).toBeLessThan(takerBefore); // the opener eats it
    expect(bystander.getHealth().nLife).toBe(bystanderBefore); // the bystander does not
  });
});
