/**
 * Credit-earning economy — Phase 1 foundation: hit() reports actual life removed,
 * per-tank last-damager, per-tank credits, depot bound to the human tank, and
 * per-team credit pooling.
 * Run: pnpm tsx tests/earning.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as { setTimeout: unknown }).setTimeout = () => 0;

import {CTank} from '../src/core/CTank';
import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, extra = ''): void {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.log(`  ✗ ${name}  ${extra}`);
    }
}

type Tanks = { m_tanks: CTank[] };

console.log('Earning economy — Phase 1');

// 1. hit() returns the LIFE actually removed (post shield + armor) — the credited qty.
{
    const t = new CTank('T', 0);              // 1000 life, no shield/armor
    ok('plain hit returns full life removed', t.hit(100) === 100 && t.getHealth().nLife === 900, `nLife=${t.getHealth().nLife}`);

    const s = new CTank('S', 0);
    s.addShield(200);                          // shield covers the hit
    ok('shield fully absorbs → 0 credited', s.hit(100) === 0 && s.getHealth().nLife === 1000 && s.getHealth().nShield === 100);

    const s2 = new CTank('S2', 0);
    s2.addShield(50);                          // shield < dmg → breaks, full dmg passes
    ok('shield break passes full damage', s2.hit(100) === 100 && s2.getHealth().nLife === 900);

    const a = new CTank('A', 0);
    a.setArmor(50);                            // 50% reduction
    ok('armor halves the credited life', a.hit(100) === 50 && a.getHealth().nLife === 950);

    const o = new CTank('O', 0);
    o.hit(970);                                // down to 30
    ok('overkill credits only remaining life', o.hit(100) === 30 && o.getHealth().nLife === 0 && !o.isAlive());
}

// 2-4. Controller: per-tank credits, last-damager cleared on spawn, depot binding.
{
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(2000);
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0], bot = tanks[1];

    ok('player 0 human, player 1 bot', human.isHuman() && !bot.isHuman());
    ok('each tank starts with the configured credits', human.getCredits() === 2000 && bot.getCredits() === 2000, `h=${human.getCredits()} b=${bot.getCredits()}`);
    ok('last-damager cleared on spawn', human.getLastDamager() === null && bot.getLastDamager() === null);

    // Depot is bound to the human tank's balance.
    ok('depot reads the human tank credits', gc.getCredits() === 2000, `d=${gc.getCredits()}`);
    human.addCredits(500);                     // "earning" the human tank
    ok('earning the human tank shows in the depot', gc.getCredits() === 2500, `d=${gc.getCredits()}`);

    const cheap = WEAPON_DATABASE.findIndex(w => w.cost > 0 && w.cost <= 1000);
    const cost = WEAPON_DATABASE[cheap].cost;
    const c0 = human.getCredits();
    ok('buying deducts from the human tank balance', gc.buyWeapon(cheap) && human.getCredits() === c0 - cost, `h=${human.getCredits()} cost=${cost}`);
}

// 5. Per-team credit pooling (4 players → teams 0,1,0,1).
{
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(1000);
    gc.startGame(4);
    const t = (gc as unknown as Tanks).m_tanks;   // teams 0,1,0,1

    t[0].setCredits(1777);
    (gc as unknown as { poolTeamCredits(tk: CTank): void }).poolTeamCredits(t[0]);
    ok('pooling copies to the same-team tank', t[2].getCredits() === 1777, `t2=${t[2].getCredits()}`);
    ok('pooling leaves the other team alone', t[1].getCredits() === 1000 && t[3].getCredits() === 1000, `t1=${t[1].getCredits()} t3=${t[3].getCredits()}`);
}

console.log(`\n${pass}/${pass + fail} earning checks passed`);
process.exit(fail ? 1 : 0);
