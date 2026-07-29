/**
 * Weapon Persistence (Gameplay setting): the weapon pick belongs to the PLAYER, not to the
 * individual tank — every tank of a squad inherits it, so the squad's next tank opens its turn
 * on whatever the player last chose. Off (the default) each tank keeps its own weapon, the
 * long-standing behaviour that weapon-selection.test.ts covers.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE, weaponName} from '../src/core/CWeapon';

const SHELL = WEAPON_DATABASE.findIndex(w => weaponName(w) === 'Shell');
const BARRAGE = WEAPON_DATABASE.findIndex(w => weaponName(w) === 'Barrage');

// Standalone accessor view over the private members the checks below reach for.
type GC = {
  setHumanCount(n: number): void;
  setTanksPerTeam(n: number): void;
  startGame(nPlayers: number): void;
  buyWeapon(index: number): boolean;
  selectWeapon(index: number): void;
  getCurrentWeaponIndex(): number;
  m_tanks: {getWeaponIndex(): number; getTeamId(): number}[];
  m_currentPlayerIndex: number;
  beginTurn(): void;
};

/** A 2-player match of 3-tank squads (tanks 0..2 = the human squad, 3..5 = the CPU's). */
function squadMatch(): GC {
  const gc = new CGameController(makeCanvas()) as unknown as GC;
  gc.setHumanCount(1);
  gc.setTanksPerTeam(3);
  gc.startGame(2);
  return gc;
}

const persist = GameConfig.weaponPersist;
afterEach(() => {
  GameConfig.weaponPersist = persist; // restore the catalog default for the next test
});

describe('Weapon Persistence', () => {
  it('is OFF by default — each tank keeps its own weapon', () => {
    expect(persist).toBe(false);
    const gc = squadMatch();
    gc.selectWeapon(BARRAGE);

    expect(gc.m_tanks[0].getWeaponIndex()).toBe(BARRAGE); // only the acting tank moved
    expect(gc.m_tanks[1].getWeaponIndex()).not.toBe(BARRAGE);

    gc.m_currentPlayerIndex = 1; // the squad's second tank takes its turn
    gc.beginTurn();
    expect(gc.getCurrentWeaponIndex()).not.toBe(BARRAGE);
  });

  it('ON: the squad inherits the pick, so the next tank opens on it', () => {
    GameConfig.weaponPersist = true;
    const gc = squadMatch();
    // Buy it first: beginTurn's ensureStocked drops a human back to the staple if the weapon
    // isn't in stock, so an unowned pick could never survive the hand-off (persistence or not).
    expect(gc.buyWeapon(BARRAGE)).toBe(true);
    gc.selectWeapon(BARRAGE);

    // Every tank of the acting player's squad now holds the choice…
    expect(gc.m_tanks[0].getWeaponIndex()).toBe(BARRAGE);
    expect(gc.m_tanks[1].getWeaponIndex()).toBe(BARRAGE);
    expect(gc.m_tanks[2].getWeaponIndex()).toBe(BARRAGE);
    // …and the turn hand-off to the squad's second tank keeps it selected.
    gc.m_currentPlayerIndex = 1;
    gc.beginTurn();
    expect(gc.getCurrentWeaponIndex()).toBe(BARRAGE);
  });

  it('ON: the choice never crosses into the OPPOSING squad', () => {
    GameConfig.weaponPersist = true;
    const gc = squadMatch();
    const enemyTeam = gc.m_tanks[3].getTeamId();
    expect(enemyTeam).not.toBe(gc.m_tanks[0].getTeamId()); // the two squads really are separate teams

    gc.selectWeapon(BARRAGE);
    for (const t of gc.m_tanks.filter(x => x.getTeamId() === enemyTeam)) {
      expect(t.getWeaponIndex()).not.toBe(BARRAGE);
    }
  });

  it('ON: a later pick replaces the squad-wide one', () => {
    GameConfig.weaponPersist = true;
    const gc = squadMatch();
    gc.selectWeapon(BARRAGE);
    gc.selectWeapon(SHELL);
    expect(gc.m_tanks[2].getWeaponIndex()).toBe(SHELL);
  });
});
