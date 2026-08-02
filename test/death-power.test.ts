/**
 * A Death round (Six Under, Toxic Grave, …) drops straight down at power 0, but its
 * submunition DRILL launches at 0.5× the FIRER's power. The shot is spawned via initFromVelocity,
 * which never sets a power, so without an explicit seed its base-power falls back to the CShot
 * default (→ a fixed 0.5×50 = 25 drill). The fix seeds the drop's base-power with the firer's power.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, getWeapon} from '../src/core/CWeapon';
import {EXT} from '../src/core/weapons/ExtType';

const DEATH = WEAPON_DATABASE.findIndex((_, i) => getWeapon(i).getExtType() === EXT.DEATH);

function fireGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  gc.setWeaponTest(true); // unlimited ammo → any weapon selectable/fireable
  return gc;
}

describe('Death weapon drill power', () => {
  it('exists in the arsenal', () => {
    expect(DEATH).toBeGreaterThanOrEqual(0);
  });

  it("the death drop carries the FIRER's power as its base-power (not the default → 25 drill)", () => {
    const gc = fireGame();
    gc.selectWeapon(DEATH);
    gc.setAngle(60);
    gc.setPower(800); // the firer's power
    gc.fire();

    const shots = priv(gc).m_shots;
    expect(shots.length).toBe(1); // one straight-down drop
    // base-power = the firer's power → the drill launches at 0.5×800, not the fixed 0.5×50 = 25.
    expect(shots[0].getBasePower()).toBe(800);
  });

  it('a different firer power flows through to the drop', () => {
    const gc = fireGame();
    gc.selectWeapon(DEATH);
    gc.setAngle(60);
    gc.setPower(300);
    gc.fire();
    expect(priv(gc).m_shots[0].getBasePower()).toBe(300);
  });
});
