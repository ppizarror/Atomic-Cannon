/**
 * Deterministic logic tests for the depot economy (credits + inventory).
 */
import {describe, it, expect} from 'vitest';

import {CEconomy, UNLIMITED} from '../src/core/CEconomy';
import {WEAPON_DATABASE, weaponName} from '../src/core/CWeapon';

const idx = (n: string) => WEAPON_DATABASE.findIndex(w => weaponName(w) === n);
const ROCKET = idx('Rocket'); // cheap
const NUKE = idx('Uranium Nuke'); // expensive
const rocketCost = WEAPON_DATABASE[ROCKET].cost;
const nukeCost = WEAPON_DATABASE[NUKE].cost;

describe('Depot economy', () => {
  it('buy deducts cost and adds stock, guarded by affordability', () => {
    const e = new CEconomy(1000, []);
    expect(e.getCredits()).toBe(1000); // starts with the given credits
    // buy deducts cost + adds a round
    expect(e.buy(ROCKET)).toBe(true);
    expect(e.getCredits()).toBe(1000 - rocketCost);
    expect(e.getOwned(ROCKET)).toBe(1);
    const e2 = new CEconomy(100, []);
    // cannot buy what you cannot afford
    expect(e2.canBuy(NUKE)).toBe(false);
    expect(e2.buy(NUKE)).toBe(false);
    expect(e2.getOwned(NUKE)).toBe(0);
  });

  it('sell refunds half (rounded) and removes stock', () => {
    const e = new CEconomy(0, []);
    // grant one round directly by buying with enough credits
    const e2 = new CEconomy(nukeCost, []);
    e2.buy(NUKE);
    // sell refunds 50% and decrements
    expect(e2.sell(NUKE)).toBe(true);
    expect(e2.getOwned(NUKE)).toBe(0);
    expect(e2.getCredits()).toBe(Math.round(nukeCost * 0.5));
    // cannot sell what you do not own
    expect(e.canSell(ROCKET)).toBe(false);
    expect(e.sell(ROCKET)).toBe(false);
  });

  it('unlimited staples are never bought/sold and always fireable', () => {
    const e = new CEconomy(9999, [ROCKET]);
    // unlimited weapon reads as ∞
    expect(e.isUnlimited(ROCKET)).toBe(true);
    expect(e.getOwned(ROCKET)).toBe(UNLIMITED);
    // unlimited cannot be bought or sold
    expect(e.canBuy(ROCKET)).toBe(false);
    expect(e.canSell(ROCKET)).toBe(false);
    // unlimited always has stock + consume
    expect(e.hasStock(ROCKET)).toBe(true);
    expect(e.consume(ROCKET)).toBe(true);
    expect(e.getOwned(ROCKET)).toBe(UNLIMITED);
  });

  it('consume depletes finite stock and blocks when empty', () => {
    const e = new CEconomy(rocketCost * 2, []);
    e.buy(ROCKET);
    e.buy(ROCKET);
    // consume decrements finite stock
    expect(e.consume(ROCKET)).toBe(true);
    expect(e.getOwned(ROCKET)).toBe(1);
    e.consume(ROCKET);
    // consume fails when empty
    expect(e.consume(ROCKET)).toBe(false);
    expect(e.getOwned(ROCKET)).toBe(0);
  });

  it('auto buy spends most of the credits on a varied loadout', () => {
    const e = new CEconomy(20000, []);
    e.autoBuy();
    const bought = WEAPON_DATABASE.reduce((n, _w, i) => n + (e.getOwned(i) > 0 ? 1 : 0), 0);
    expect(bought).toBeGreaterThanOrEqual(3); // auto buy stocks several distinct weapons
    expect(e.getCredits()).toBeLessThan(20000); // auto buy spends credits
    expect(e.getCredits()).toBeGreaterThanOrEqual(0); // auto buy never overspends
  });

  it('auto buy stocks only OFFENSIVE weapons — never utility/support types', () => {
    // extTypes the AI never buys: MOVE, TRACER, SHIELD, HEAL, ARMOR, DEATH, HAZMAT, MINE, JET.
    const SKIP = new Set([3, 4, 7, 10, 11, 12, 14, 16, 17]);
    const e = new CEconomy(200000, []); // plenty of credits → it would grab everything affordable
    e.autoBuy();
    const boughtUtility = WEAPON_DATABASE.some(
      (w, i) => e.getOwned(i) > 0 && SKIP.has(w.extType ?? 0),
    );
    expect(boughtUtility).toBe(false); // utility/support types are filtered out
  });

  it('auto buy (conserve) spends without overspending', () => {
    const e = new CEconomy(20000, []);
    e.autoBuy({conserve: true}); // tough-AI branch: half the picks are the weakest filler
    expect(e.getCredits()).toBeLessThan(20000); // still spends
    expect(e.getCredits()).toBeGreaterThanOrEqual(0); // never overspends
  });
});
