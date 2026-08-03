/**
 * Two gameplay rules:
 *  1. A weapon crate grants to WHOEVER grabs it — a CPU tank driving over one collects the
 *     contents like anybody else, rather than the crate vanishing for free. (A `bomb` crate is a
 *     trap and pays out nothing; that path is covered in crate-bomb.test.ts.)
 *  2. Radiation fallout DOT is neutralized in NET matches (cosmetic only), because it accrues per
 *     frame over the un-synchronized aim phase and would drift/false-desync lockstep clients — the
 *     same treatment wind gusts already get. Solo keeps full radiation damage.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import type {CTank} from '../src/core/CTank';

type Econ = {isUnlimited(i: number): boolean; getOwned(i: number): number};
type Priv = {
  m_tanks: CTank[];
  m_netMode: boolean;
  m_gameState: EGameState;
  m_land: {getRadiationZones(): unknown; radiationAt(x: number): boolean};
  economyFor(t: CTank): Econ;
  collectCrate(c: unknown, tank: CTank): void;
  updateBattle(dt: number): void;
};

function botGame(): Priv {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(0); // all CPU
  gc.startGame(3);
  return gc as unknown as Priv;
}

function crate(weaponIndex: number) {
  return {x: 0, y: 0, vy: 0, kind: 'weapon', amount: 0, weaponIndex, landed: true, phase: 0, id: 1};
}

describe('crate grant to bots', () => {
  it('a solo bot collecting a weapon crate actually receives the weapon', () => {
    const p = botGame();
    const bot = p.m_tanks[0];
    const econ = p.economyFor(bot);
    let widx = 1;
    while (widx < WEAPON_DATABASE.length && econ.isUnlimited(widx)) widx++; // first finite weapon
    const before = econ.getOwned(widx);

    p.collectCrate(crate(widx), bot);

    expect(econ.getOwned(widx)).toBe(before + 1); // was: bot got nothing, crate vanished for free
  });
});

describe('radiation DOT neutralized in net', () => {
  const stubZone = (p: Priv) => {
    p.m_land.getRadiationZones = () => [{damagePerSecond: 50}];
    p.m_land.radiationAt = () => true;
    p.m_gameState = EGameState.Battle;
  };

  it('solo: a tank on live fallout takes damage-over-time', () => {
    const prev = GameConfig.radiationDamage;
    GameConfig.radiationDamage = true;
    try {
      const p = botGame();
      stubZone(p);
      const life0 = p.m_tanks[0].getHealth().nLife;
      p.updateBattle(0.1); // 50 dps × 0.1s = 5 damage
      expect(p.m_tanks[0].getHealth().nLife).toBeLessThan(life0);
    } finally {
      GameConfig.radiationDamage = prev;
    }
  });

  it('net: the same fallout deals NO damage (cosmetic only → lockstep-safe)', () => {
    const prev = GameConfig.radiationDamage;
    GameConfig.radiationDamage = true;
    try {
      const p = botGame();
      p.m_netMode = true;
      stubZone(p);
      const life0 = p.m_tanks[0].getHealth().nLife;
      p.updateBattle(0.1);
      expect(p.m_tanks[0].getHealth().nLife).toBe(life0); // unchanged — DOT is off in net
    } finally {
      GameConfig.radiationDamage = prev;
    }
  });
});
