/**
 * Settings → game: the persisted options actually reach the engine. Drives the real
 * bridge (settingsStore → settingsValues → applyGameSettings → controller) and checks
 * CEconomy's configurable sell rate + reset.
 * Run: pnpm tsx tests/settings.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();

// Freeze the turn scheduler so nothing auto-cascades after startGame.
(globalThis as unknown as { setTimeout: unknown }).setTimeout = () => 0;

import {CGameController} from '../src/game/CGameController';
import {CEconomy} from '../src/core/CEconomy';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {setVal} from '../src/ui/settingsStore';
import {applyGameSettings} from '../src/ui/applySettings';

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

const NUKE = WEAPON_DATABASE.findIndex(w => w.name === 'Uranium Nuke');
const nukeCost = WEAPON_DATABASE[NUKE].cost;

// Private-field view for asserting the bridge pushed live values.
type GCInternals = { m_speedScale: number; m_variance: boolean; m_landMode: number; m_windScale: number };

console.log('Settings → game');

// 1. CEconomy: reset(startCredits) + configurable sell-back rate.
{
    const e = new CEconomy(3000, []);
    e.reset(1500);
    ok('reset sets the start credits', e.getCredits() === 1500, `cr=${e.getCredits()}`);

    const e2 = new CEconomy(nukeCost, []);
    e2.setSellRate(0.8);
    e2.buy(NUKE);
    ok('sell refunds at the configured rate (80%)',
        e2.sell(NUKE) && e2.getCredits() === Math.round(nukeCost * 0.8), `cr=${e2.getCredits()}`);
}

// 2. Full bridge: set stored options → applyGameSettings → controller reflects them.
{
    setVal('eco.creditStart', 1234);
    setVal('gp.battles', 9);
    setVal('gp.wind', 0);          // Disabled
    setVal('gp.difficulty', 0);    // "1. Easiest" → AI level 1
    setVal('gp.updateScale', 20);  // 2.0× game speed
    setVal('gp.variance', 0);      // off
    setVal('gfx.landType', 0);     // Flat (mode 0)

    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    gc.startGame(2);
    const priv = gc as unknown as GCInternals;

    ok('Credit Start reaches the match', gc.getCredits() === 1234, `cr=${gc.getCredits()}`);
    ok('Battles reaches getTotalBattles', gc.getTotalBattles() === 9, `n=${gc.getTotalBattles()}`);
    ok('Wind Disabled → zero wind', gc.getWindValue() === 0, `w=${gc.getWindValue()}`);
    ok('Difficulty applied (Easiest = level 1)', gc.getDifficulty() === 1, `d=${gc.getDifficulty()}`);
    ok('Update Scale → 2× speed', priv.m_speedScale === 2, `s=${priv.m_speedScale}`);
    ok('Variance off is applied', priv.m_variance === false, `v=${priv.m_variance}`);
    ok('Land Type Flat → mode 0', priv.m_landMode === 0, `m=${priv.m_landMode}`);
}

// 3. Live change: re-applying picks up a new value immediately (High wind scalar).
{
    setVal('gp.wind', 3);          // High → scalar 1.6
    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    const priv = gc as unknown as GCInternals;
    ok('changing Wind re-applies the scalar', priv.m_windScale === 1.6, `ws=${priv.m_windScale}`);

    // And a fresh match honours it: |wind| stays within the scaled bound.
    gc.startGame(2);
    ok('wind is seeded within the scaled bound', Math.abs(gc.getWindValue()) <= 5 * 1.6 + 1e-9, `w=${gc.getWindValue()}`);
}

console.log(`\n${pass}/${pass + fail} settings checks passed`);
process.exit(fail ? 1 : 0);
