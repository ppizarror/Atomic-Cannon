/**
 * MatchConfig is the host's gameplay settings, adopted verbatim by every client so the
 * deterministic simulation agrees. It used to be spelled out field-by-field in four places —
 * the interface, `getMatchConfig`, the apply block in `startNetworkGame`, and the room's
 * `sanitizeConfig` — so a field added to one and missed in another produced no error at all:
 * clients silently ran different physics and the match desynced on the first shot.
 *
 * Both engine halves now read one binding table and the server shares the client's sanitizer.
 * These tests pin the property that made the drift dangerous: whatever `getMatchConfig` can
 * REPORT, `startNetworkGame` must APPLY — a read-only field would come back stale here.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {sanitizeMatchConfig, type MatchConfig} from '../src/net/protocol';

/** A config that differs from the defaults in EVERY field, so a field the apply half skips
 *  shows up as a stale value rather than coincidentally matching. */
const DISTINCT: MatchConfig = {
  hitpoints: 1234,
  tankSizeScale: 1.35,
  explosionScale: 1.8,
  powerScale: 0.75,
  kickbackScale: 0.6,
  buryTanks: true,
  variance: false,
  relativeTurrets: true,
  utilityTurn: true,
  randomizePosition: true,
  roundTime: 45,
  crateChance: 77,
  radiationDamage: false,
  startCredits: 9100,
  gameType: 0,
  sellRate: 0.25,
  creditDamage: 3,
  creditKill: 750,
  creditTurn: 12,
  creditRound: 1500,
};

function bootNet(config: MatchConfig): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.startNetworkGame({
    seed: 42,
    players: 2,
    localIndex: 0,
    roster: [
      {name: 'Ada', color: '#f00'},
      {name: 'Bo', color: '#0f0'},
    ],
    wind: 1,
    mapSize: 2,
    battles: 1,
    tanksPerTeam: 1,
    currentBattle: 1,
    viewW: 1280,
    viewH: 720,
    config,
  });
  return gc;
}

describe('MatchConfig round-trip', () => {
  it('applies every field it reports — a client mirrors the host exactly', () => {
    expect(bootNet(DISTINCT).getMatchConfig()).toEqual(DISTINCT);
  });

  it('covers the defaults too (no field silently pinned to a local value)', () => {
    const dflt = sanitizeMatchConfig();
    expect(bootNet(dflt).getMatchConfig()).toEqual(dflt);
  });

  it('gameType collapses to Rounds or Deathmatch, never a third state', () => {
    expect(bootNet({...DISTINCT, gameType: 0}).getMatchConfig().gameType).toBe(0);
    expect(bootNet({...DISTINCT, gameType: 1}).getMatchConfig().gameType).toBe(1);
  });
});

describe('sanitizeMatchConfig', () => {
  it('fills every field when given nothing', () => {
    const c = sanitizeMatchConfig();
    // Same key set the engine round-trips, so the fixture can never fall short of the interface.
    expect(Object.keys(c).sort()).toEqual(Object.keys(DISTINCT).sort());
    for (const v of Object.values(c)) expect(v).not.toBeUndefined();
  });

  it('clamps out-of-range numbers instead of trusting the host', () => {
    const c = sanitizeMatchConfig({hitpoints: -5, sellRate: 99, crateChance: 1000});
    expect(c.hitpoints).toBe(1); // lo
    expect(c.sellRate).toBe(1); // hi
    expect(c.crateChance).toBe(100); // hi
  });

  it('falls back to defaults for non-finite / wrong-typed values', () => {
    const bad = {hitpoints: NaN, powerScale: 'fast', variance: 'yes'} as unknown as MatchConfig;
    const c = sanitizeMatchConfig(bad);
    expect(c.hitpoints).toBe(1000);
    expect(c.powerScale).toBe(1);
    expect(c.variance).toBe(true);
  });

  it('keeps a valid explicit false rather than defaulting it back on', () => {
    expect(sanitizeMatchConfig({variance: false}).variance).toBe(false);
    expect(sanitizeMatchConfig({radiationDamage: false}).radiationDamage).toBe(false);
  });
});
