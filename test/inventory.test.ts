/**
 * Weapon inventory ↔ firing loop: buying stocks a weapon, the human's shot consumes a
 * round, the Shell is unlimited, and the arsenal only lists weapons in stock (you can't
 * select — or fire — a weapon you don't own). Closes the "depot is cosmetic" gap.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, getDefaultWeaponIndex} from '../src/core/CWeapon';

const SHELL = getDefaultWeaponIndex();
// A buyable weapon: any costed weapon that isn't the free staple. Looked up by cost (not
// by display name) so it's independent of the i18n weapon-name scheme.
const NUKE = WEAPON_DATABASE.findIndex(w => w.index !== SHELL && (w.cost ?? 0) > 0);

type GCInternals = {beginTurn(): void};
const priv = (gc: CGameController) => gc as unknown as GCInternals;

/** A fresh match with a human at index 0 and plenty of credits to buy with. */
function humanGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setStartCredits(10_000_000);
  gc.setHumanCount(1);
  gc.startGame(2);
  return gc;
}

describe('Weapon inventory ↔ firing', () => {
  it('arsenal lists only owned weapons on the human turn (Shell + what was bought)', () => {
    const gc = humanGame();
    // Fresh match: only the unlimited Shell is in stock.
    expect(gc.getWeaponDefs().map(w => w.index)).toEqual([SHELL]);

    expect(gc.buyWeapon(NUKE)).toBe(true);
    const idx = gc.getWeaponDefs().map(w => w.index);
    expect(idx).toContain(SHELL);
    expect(idx).toContain(NUKE);
    // A costed weapon we never bought stays out of the list.
    const unowned = WEAPON_DATABASE.findIndex((w, i) => i !== SHELL && i !== NUKE && w.cost > 0);
    expect(idx).not.toContain(unowned);
  });

  it('firing a finite weapon consumes one round; the Shell never depletes', () => {
    const gc = humanGame();
    gc.buyWeapon(NUKE);
    gc.buyWeapon(NUKE);
    expect(gc.getOwnedCounts()[NUKE]).toBe(2);

    gc.selectWeapon(NUKE);
    gc.fire();
    expect(gc.getOwnedCounts()[NUKE]).toBe(1); // one round spent

    priv(gc).beginTurn(); // back to the human, Nuke still in stock
    gc.selectWeapon(SHELL);
    const shellBefore = gc.getOwnedCounts()[SHELL];
    gc.fire();
    expect(gc.getOwnedCounts()[SHELL]).toBe(shellBefore); // unlimited stays unlimited
  });

  it('weapon-test mode (?weapontest=1) makes the WHOLE inventory unlimited (one source of truth)', () => {
    const gc = humanGame();
    gc.setWeaponTest(true);

    // Free-fire is economy state: every weapon reads as unlimited, so the depot Qty
    // column shows ∞ (not 0) and the full arsenal is selectable.
    expect(gc.isUnlimitedWeapon(NUKE)).toBe(true);
    expect(gc.getOwnedCounts()[NUKE]).toBe(Infinity);
    const idx = gc.getWeaponDefs().map(w => w.index);
    expect(idx.length).toBeGreaterThan(1);
    expect(idx).toContain(NUKE);

    // Firing an "unowned" weapon works and depletes nothing.
    gc.selectWeapon(NUKE);
    gc.fire();
    expect(gc.isUnlimitedWeapon(NUKE)).toBe(true);

    // The selected weapon carries across the turn — no forced fallback to the Shell.
    priv(gc).beginTurn();
    expect(gc.getCurrentWeaponIndex()).toBe(NUKE);

    // Turning it off restores a normal inventory (only the Shell is unlimited again).
    gc.setWeaponTest(false);
    expect(gc.isUnlimitedWeapon(NUKE)).toBe(false);
    expect(gc.isUnlimitedWeapon(SHELL)).toBe(true);
  });

  it('emptying a weapon auto-selects the Shell next turn (never opens out of stock)', () => {
    const gc = humanGame();
    gc.buyWeapon(NUKE); // own exactly one
    gc.selectWeapon(NUKE);
    gc.fire(); // spends the last Nuke
    expect(gc.getOwnedCounts()[NUKE]).toBe(0);

    priv(gc).beginTurn();
    expect(gc.getCurrentWeaponIndex()).toBe(SHELL); // fell back to the staple
    // And the emptied Nuke is gone from the selectable arsenal.
    expect(gc.getWeaponDefs().map(w => w.index)).not.toContain(NUKE);
  });
});
