/**
 * Deterministic logic tests for the depot economy (credits + inventory).
 * Run: pnpm tsx tests/economy.test.ts   (or `pnpm test`)
 */
import {CEconomy, UNLIMITED} from '../src/core/CEconomy';
import {WEAPON_DATABASE} from '../src/core/CWeapon';

let pass = 0,
  fail = 0;

function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

const idx = (n: string) => WEAPON_DATABASE.findIndex(w => w.name === n);
const ROCKET = idx('Rocket'); // cheap
const NUKE = idx('Uranium Nuke'); // expensive
const rocketCost = WEAPON_DATABASE[ROCKET].cost;
const nukeCost = WEAPON_DATABASE[NUKE].cost;

console.log('Depot economy');

// 1. Buy deducts cost and adds stock; guarded by affordability.
{
  const e = new CEconomy(1000, []);
  ok('starts with the given credits', e.getCredits() === 1000);
  ok(
    'buy deducts cost + adds a round',
    e.buy(ROCKET) && e.getCredits() === 1000 - rocketCost && e.getOwned(ROCKET) === 1,
    `cr=${e.getCredits()} owned=${e.getOwned(ROCKET)}`,
  );
  const e2 = new CEconomy(100, []);
  ok(
    'cannot buy what you cannot afford',
    !e2.canBuy(NUKE) && !e2.buy(NUKE) && e2.getOwned(NUKE) === 0,
  );
}

// 2. Sell refunds half (rounded) and removes stock.
{
  const e = new CEconomy(0, []);
  // grant one round directly by buying with enough credits
  const e2 = new CEconomy(nukeCost, []);
  e2.buy(NUKE);
  ok(
    'sell refunds 50% and decrements',
    e2.sell(NUKE) && e2.getOwned(NUKE) === 0 && e2.getCredits() === Math.round(nukeCost * 0.5),
    `cr=${e2.getCredits()}`,
  );
  ok('cannot sell what you do not own', !e.canSell(ROCKET) && !e.sell(ROCKET));
}

// 3. Unlimited staples: never bought/sold, always fireable.
{
  const e = new CEconomy(9999, [ROCKET]);
  ok('unlimited weapon reads as ∞', e.isUnlimited(ROCKET) && e.getOwned(ROCKET) === UNLIMITED);
  ok('unlimited cannot be bought or sold', !e.canBuy(ROCKET) && !e.canSell(ROCKET));
  ok(
    'unlimited always has stock + consume',
    e.hasStock(ROCKET) && e.consume(ROCKET) && e.getOwned(ROCKET) === UNLIMITED,
  );
}

// 4. Consume depletes finite stock, blocks when empty.
{
  const e = new CEconomy(rocketCost * 2, []);
  e.buy(ROCKET);
  e.buy(ROCKET);
  ok('consume decrements finite stock', e.consume(ROCKET) && e.getOwned(ROCKET) === 1);
  e.consume(ROCKET);
  ok('consume fails when empty', !e.consume(ROCKET) && e.getOwned(ROCKET) === 0);
}

// 5. Auto Buy spends most of the credits on a varied loadout.
{
  const e = new CEconomy(20000, []);
  e.autoBuy();
  const bought = WEAPON_DATABASE.reduce((n, _w, i) => n + (e.getOwned(i) > 0 ? 1 : 0), 0);
  ok('auto buy stocks several distinct weapons', bought >= 3, `distinct=${bought}`);
  ok('auto buy spends credits', e.getCredits() < 20000, `left=${e.getCredits()}`);
  ok('auto buy never overspends', e.getCredits() >= 0);
}

console.log(`\n${pass}/${pass + fail} economy checks passed`);
process.exit(fail ? 1 : 0);
