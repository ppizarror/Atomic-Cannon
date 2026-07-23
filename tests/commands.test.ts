/**
 * The command bus: every GameCommand dispatches to the right target method
 * (the injection seam the network/replay layers use), and driving a real
 * CGameController through applyCommand — aim then fire — actually launches a
 * shot, exactly as a remote turn will.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {applyCommand, type CommandTarget, type GameCommand} from '../src/net/commands';
import {CGameController} from '../src/game/CGameController';

/** A CommandTarget that records the calls it receives. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return ret;
    };
  const target: CommandTarget = {
    setAngle: rec('setAngle'),
    setPower: rec('setPower'),
    resetAim: rec('resetAim'),
    selectWeapon: rec('selectWeapon'),
    buyWeapon: rec('buyWeapon', true) as CommandTarget['buyWeapon'],
    sellWeapon: rec('sellWeapon', true) as CommandTarget['sellWeapon'],
    autoBuyWeapons: rec('autoBuyWeapons'),
    commandMoveTo: rec('commandMoveTo'),
    setJetInput: rec('setJetInput'),
    cutJet: rec('cutJet'),
    fire: rec('fire'),
  };
  return {target, calls};
}

describe('applyCommand dispatch', () => {
  it('maps each command to its method with the right args', () => {
    const cases: Array<[GameCommand, [string, ...unknown[]][]]> = [
      [
        {t: 'aim', angle: 45, power: 300},
        [
          ['setAngle', 45],
          ['setPower', 300],
        ],
      ],
      [{t: 'resetAim'}, [['resetAim']]],
      [{t: 'selectWeapon', index: 7}, [['selectWeapon', 7]]],
      [{t: 'buy', index: 3}, [['buyWeapon', 3]]],
      [{t: 'sell', index: 3}, [['sellWeapon', 3]]],
      [{t: 'autobuy'}, [['autoBuyWeapons']]],
      [{t: 'move', destX: 512}, [['commandMoveTo', 512]]],
      [{t: 'jet', up: true, left: false, right: true}, [['setJetInput', true, false, true]]],
      [{t: 'cutJet'}, [['cutJet']]],
      [{t: 'fire'}, [['fire']]],
    ];
    for (const [cmd, expected] of cases) {
      const {target, calls} = recorder();
      applyCommand(target, cmd);
      expect(calls).toEqual(expected);
    }
  });
});

describe('applyCommand drives a real game', () => {
  function humanGame(): CGameController {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(10_000_000);
    gc.setHumanCount(1);
    gc.startGame(2);
    return gc;
  }

  it('aim sets angle/power; fire launches a shot', () => {
    const gc = humanGame();
    expect(gc.isPlayerTurn()).toBe(true);

    applyCommand(gc, {t: 'aim', angle: 60, power: 250});
    expect(gc.getAngle()).toBe(60);
    expect(gc.getPower()).toBe(250);

    expect(gc.getShotCount()).toBe(0);
    applyCommand(gc, {t: 'fire'});
    // A ballistic staple shot is now in flight (state left Battle / a shot exists).
    expect(gc.getShotCount()).toBeGreaterThan(0);
  });
});
