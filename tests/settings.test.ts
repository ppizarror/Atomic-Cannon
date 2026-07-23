/**
 * Settings → game: the persisted options actually reach the engine. Drives the real
 * bridge (settingsStore → settingsValues → applyGameSettings → controller) and checks
 * CEconomy's configurable sell rate + reset.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {CEconomy} from '../src/core/CEconomy';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {GameConfig} from '../src/core/CGameConfig';
import {setVal} from '../src/ui/settingsStore';
import {applyGameSettings} from '../src/ui/applySettings';
import {showFramerate, showFrameCount, maxFps} from '../src/ui/store';
import {SETTINGS} from '../src/ui/settingsCatalog';

const NUKE = WEAPON_DATABASE.findIndex(w => w.name === 'Uranium Nuke');
const nukeCost = WEAPON_DATABASE[NUKE].cost;

// Private-field view for asserting the bridge pushed live values.
type GCInternals = {
  m_speedScale: number;
  m_variance: boolean;
  m_landMode: number;
  m_windScale: number;
};

describe('Settings → game', () => {
  it('CEconomy reset(startCredits) + configurable sell-back rate', () => {
    const e = new CEconomy(3000, []);
    e.reset(1500);
    expect(e.getCredits()).toBe(1500); // reset sets the start credits

    const e2 = new CEconomy(nukeCost, []);
    e2.setSellRate(0.8);
    e2.buy(NUKE);
    // sell refunds at the configured rate (80%)
    expect(e2.sell(NUKE)).toBe(true);
    expect(e2.getCredits()).toBe(Math.round(nukeCost * 0.8));
  });

  it('full bridge: stored options → applyGameSettings → controller reflects them', () => {
    setVal('eco.creditStart', 1234);
    setVal('gp.battles', 9);
    setVal('gp.wind', 0); // Disabled
    setVal('gp.difficulty', 0); // "1. Easiest" → AI level 1
    setVal('gp.updateScale', 20); // 2.0× game speed
    setVal('gp.variance', 0); // off
    setVal('gfx.landType', 0); // Flat (mode 0)

    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    gc.startGame(2);
    const priv = gc as unknown as GCInternals;

    expect(gc.getCredits()).toBe(1234); // Credit Start reaches the match
    expect(gc.getTotalBattles()).toBe(9); // Battles reaches getTotalBattles
    expect(gc.getWindValue() === 0).toBe(true); // Wind Disabled → zero wind
    expect(gc.getDifficulty()).toBe(1); // Difficulty applied (Easiest = level 1)
    expect(priv.m_speedScale).toBe(2); // Update Scale → 2× speed
    expect(priv.m_variance).toBe(false); // Variance off is applied
    expect(priv.m_landMode).toBe(0); // Land Type Flat → mode 0
  });

  it('live change: re-applying picks up a new value immediately (High wind scalar)', () => {
    setVal('gp.wind', 3); // High → scalar 1.6
    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    const priv = gc as unknown as GCInternals;
    expect(priv.m_windScale).toBe(1.6); // changing Wind re-applies the scalar

    // And a fresh match honours it: |wind| stays within the scaled bound.
    gc.startGame(2);
    // wind is seeded within the scaled bound
    expect(Math.abs(gc.getWindValue())).toBeLessThanOrEqual(5 * 1.6 + 1e-9);
  });

  it('GameConfig scalars + render toggles, and Hitpoints on the spawned tank', () => {
    setVal('tank.hitpoints', 2500);
    setVal('tank.kickback', 0); // Off → scalar 0
    setVal('gp.explosionSize', 3); // Massive → 1.8
    setVal('tank.powerScale', 150); // 1.5×
    setVal('gfx.showPower', 0); // bars off
    setVal('gfx.expWaves', 0); // nuke wave off

    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    expect(GameConfig.kickbackScale).toBe(0); // Kickback Off → scalar 0
    expect(GameConfig.explosionScale).toBe(1.8); // Explosion Massive → 1.8
    expect(GameConfig.powerScale).toBe(1.5); // Power Scale 150% → 1.5
    expect(GameConfig.showPowerBars).toBe(false); // Show Power off is applied
    expect(GameConfig.explosionWaves).toBe(false); // Explosion Waves off is applied

    gc.startGame(2);
    const tank = (
      gc as unknown as {m_tanks: {getMaxLife(): number; getHealth(): {nLife: number}}[]}
    ).m_tanks[0];
    expect(tank.getMaxLife()).toBe(2500); // Hitpoints → tank max life
    expect(tank.getHealth().nLife).toBe(2500); // Hitpoints → tank spawns full
  });

  it('Show Framerate enum drives the FPS + frame-count overlays (Off/FPS/Full)', () => {
    const gc = new CGameController(makeCanvas());

    setVal('gfx.framerate', 0); // Off
    applyGameSettings(gc);
    expect(showFramerate.value).toBe(false);
    expect(showFrameCount.value).toBe(false);

    setVal('gfx.framerate', 1); // FPS only
    applyGameSettings(gc);
    expect(showFramerate.value).toBe(true);
    expect(showFrameCount.value).toBe(false);

    setVal('gfx.framerate', 2); // Full → FPS + frame count
    applyGameSettings(gc);
    expect(showFramerate.value).toBe(true);
    expect(showFrameCount.value).toBe(true);
  });

  it('Max Framerate enum maps to a ticker FPS cap (No Limit = 0)', () => {
    const gc = new CGameController(makeCanvas());
    const expect_ = (idx: number, cap: number) => {
      setVal('gfx.fpsCap', idx);
      applyGameSettings(gc);
      expect(maxFps.value).toBe(cap);
    };
    expect_(0, 0); // No Limit → uncapped
    expect_(1, 30);
    expect_(2, 60);
    expect_(3, 120);
    expect_(4, 144);
  });

  it('Show Points + Auto Scroll toggles reach GameConfig (were silent no-ops)', () => {
    setVal('gfx.showPoints', 0);
    setVal('gfx.autoScroll', 0);
    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    expect(GameConfig.showPoints).toBe(false); // Show Points off is applied
    expect(GameConfig.autoScroll).toBe(false); // Auto Scroll off is applied

    setVal('gfx.showPoints', 1);
    setVal('gfx.autoScroll', 1);
    applyGameSettings(gc);
    expect(GameConfig.showPoints).toBe(true); // and re-applying picks the new value up
    expect(GameConfig.autoScroll).toBe(true);
  });

  it('Tank Size (geometry scalar → collision radius) + Draw Smoke', () => {
    setVal('tank.size', 2); // Large → 1.35
    setVal('gfx.smoke', 0); // off
    const gc = new CGameController(makeCanvas());
    applyGameSettings(gc);
    expect(GameConfig.tankSizeScale).toBe(1.35); // Player Size Large → scalar 1.35
    expect(GameConfig.drawSmoke).toBe(false); // Draw Smoke off is applied

    gc.startGame(2);
    const tank = (gc as unknown as {m_tanks: {getHitRadius(): number}[]}).m_tanks[0];
    // hit radius scales with size (16 × 1.35)
    expect(Math.abs(tank.getHitRadius() - 16 * 1.35)).toBeLessThan(1e-9);
  });
});

describe('settings catalog (single source)', () => {
  it('every enum with an engine scale table has matching option/scale lengths', () => {
    for (const [id, meta] of Object.entries(SETTINGS)) {
      if (meta.scale) {
        expect(meta.options, `${id} has a scale table but no option labels`).toBeDefined();
        expect(meta.scale.length, `${id}: option/scale length mismatch`).toBe(meta.options!.length);
      }
    }
  });

  it('defaults + scalar tables match the known values (regression guard)', () => {
    expect(SETTINGS['eco.creditStart'].default).toBe(3000);
    expect(SETTINGS['gp.difficulty'].default).toBe(4);
    expect(SETTINGS['tank.hitpoints'].default).toBe(1000);
    expect(SETTINGS['gp.wind'].scale).toEqual([0, 0.5, 1, 1.6]);
    expect(SETTINGS['tank.kickback'].scale).toEqual([0, 0.6, 1, 1.5]);
    expect(SETTINGS['gp.explosionSize'].scale).toEqual([0.7, 1, 1.35, 1.8]);
    expect(SETTINGS['tank.size'].scale).toEqual([0.72, 1, 1.35]);
    expect(SETTINGS['gfx.fpsCap'].scale).toEqual([0, 30, 60, 120, 144]);
  });
});
