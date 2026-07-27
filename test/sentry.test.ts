/**
 * Sentry turrets: a deployed Sentry weapon becomes a stationary "Sentry" tank on the
 * owner's team that renders with the Sentry sprites, takes damage, auto-aims at the
 * nearest enemy and fires in a direct line (Turret → Shell, Minigun → Machine Gun, and
 * the Minigun variant is tougher). Sentries don't count toward the battle win.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameState} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {CLand} from '../src/core/CLand';
import {WEAPON_DATABASE, weaponName} from '../src/core/CWeapon';
import {GameConfig} from '../src/core/CGameConfig';

// Weapon display names now come from i18n (data/weapons.json carries only the id slug),
// so look weapons up by their localised name.
const idxOf = (name: string) => WEAPON_DATABASE.findIndex(w => weaponName(w) === name);
const SENTRY_TURRET = idxOf('Sentry Turret');
const SENTRY_MINIGUN = idxOf('Sentry Minigun');
const SHELL = idxOf('Shell');
const MACHINE_GUN = idxOf('Machine Gun');

// Private-field view for driving the internals a real deploy/turn would.
type GCInternals = {
  m_tanks: CTank[];
  m_currentPlayerIndex: number;
  m_gameState: EGameState;
  m_land: CLand;
  executeSentryTurn(): void;
  endBattleIfDecided(): void;
  fire(): void;
};

const priv = (gc: CGameController) => gc as unknown as GCInternals;

/** Spawn a match and return the controller + its two enemy tanks. */
function twoPlayerGame(): {gc: CGameController; a: CTank; b: CTank} {
  GameConfig.hitpoints = 1000;
  const gc = new CGameController(makeCanvas());
  gc.startGame(2);
  const [a, b] = priv(gc).m_tanks;
  return {gc, a, b};
}

describe('Sentry turrets', () => {
  it('deploys as a stationary "Sentry" tank on the owner team, using the Sentry sprites', () => {
    const {gc, a} = twoPlayerGame();
    const before = priv(gc).m_tanks.length;

    gc.deploySentry(a.getPosition().x + 30, 0, a, SENTRY_TURRET);

    const tanks = priv(gc).m_tanks;
    expect(tanks.length).toBe(before + 1); // a new entity joined the field
    const sentry = tanks[tanks.length - 1];
    expect(sentry.getTankType()).toBe('Sentry'); // → tanks/Sentry body|turret|wreck sprites
    // The badge shows the OWNER's name (the type "Sentry" is internal, never drawn).
    expect(sentry.getName()).toBe(a.getName());
    expect(sentry.getTeamId()).toBe(a.getTeamId()); // fights for its owner's team
    expect(sentry.isAlive()).toBe(true);
    expect(sentry.getMaxLife()).toBe(200); // Turret HP = its deploy weapon's fixed value (not match HP)
  });

  it('Minigun variant has more health than the Turret variant', () => {
    const {gc, a} = twoPlayerGame();
    gc.deploySentry(a.getPosition().x + 30, 0, a, SENTRY_MINIGUN);
    const sentry = priv(gc).m_tanks.at(-1)!;
    // A fixed per-weapon value (500), not the match Hit-Points nor a ×2 — but still tougher than the Turret's 200.
    expect(sentry.getMaxLife()).toBe(500);
  });

  it('on its turn a sentry aims at the nearest enemy and picks the right weapon', () => {
    const {gc, a, b} = twoPlayerGame();
    // Park the enemy to the RIGHT of where the sentry drops.
    const sentryX = a.getPosition().x;
    b.respawn(sentryX + 200, priv(gc).m_land);

    gc.deploySentry(sentryX, 0, a, SENTRY_TURRET);
    const sentry = priv(gc).m_tanks.at(-1)!;

    // Make the sentry the acting tank and run its turn (aim + weapon select happen
    // synchronously; the shot itself is scheduled).
    priv(gc).m_currentPlayerIndex = priv(gc).m_tanks.indexOf(sentry);
    priv(gc).executeSentryTurn();

    expect(sentry.getWeaponIndex()).toBe(SHELL); // Turret variant → Shell
    // Aimed toward the enemy on the right: barrel points right (positive x component).
    expect(sentry.aimUnit().x).toBeGreaterThan(0);
  });

  it('Minigun variant fires the Machine Gun on its turn', () => {
    const {gc, a, b} = twoPlayerGame();
    b.respawn(a.getPosition().x + 150, priv(gc).m_land);
    gc.deploySentry(a.getPosition().x, 0, a, SENTRY_MINIGUN);
    const sentry = priv(gc).m_tanks.at(-1)!;
    priv(gc).m_currentPlayerIndex = priv(gc).m_tanks.indexOf(sentry);
    priv(gc).executeSentryTurn();
    expect(sentry.getWeaponIndex()).toBe(MACHINE_GUN >= 0 ? MACHINE_GUN : SHELL);
  });

  it('Minigun sentry still holds the Machine Gun THROUGH fire() (not swapped to the staple Shell)', () => {
    const {gc, a, b} = twoPlayerGame();
    b.respawn(a.getPosition().x + 150, priv(gc).m_land);
    gc.deploySentry(a.getPosition().x, 0, a, SENTRY_MINIGUN);
    const sentry = priv(gc).m_tanks.at(-1)!;
    priv(gc).m_currentPlayerIndex = priv(gc).m_tanks.indexOf(sentry);
    priv(gc).m_gameState = EGameState.Battle;
    priv(gc).executeSentryTurn();
    expect(sentry.getWeaponIndex()).toBe(MACHINE_GUN); // selected the Machine Gun

    // fire() is what the sentry's scheduled turn calls. A sentry reports isBot(), so before the fix it
    // hit the ammo-charge path → ensureStocked found no MG rounds in its empty economy → swapped it
    // back to the Shell. It must now keep the Machine Gun (sentries don't draw from an inventory).
    priv(gc).fire();
    expect(sentry.getWeaponIndex()).toBe(MACHINE_GUN);
  });

  it('a living sentry does not keep a decided battle alive (excluded from the win count)', () => {
    const {gc, a, b} = twoPlayerGame();
    gc.deploySentry(a.getPosition().x + 30, 0, a, SENTRY_TURRET);
    // Only the owner (a) + their sentry survive — b, the sole enemy player, dies.
    b.hit(999999);
    expect(b.isAlive()).toBe(false);

    priv(gc).m_gameState = EGameState.Battle; // endBattleIfDecided only acts in Battle
    priv(gc).endBattleIfDecided();
    // Down to one living PLAYER → the battle ends despite the sentry still standing.
    expect(priv(gc).m_gameState).toBe(EGameState.BattleEnd);
  });
});
