/**
 * Multi-fire cadence (spawn fan vs. succession stream) — recovered from the original's
 * fire path (a SIMULTANEOUS spread at launch + an OVER-TIME salvo queue drained by the
 * battle loop):
 *   • `spawn` rounds leave in ONE frame, `spread`° apart (a fan);
 *   • `sucNum` extra salvos follow SEQUENTIALLY, each a fresh full fan;
 *   • the inter-salvo gap is `sucSec` measured in the engine's ballistic time-step,
 *     so it converts to our seconds by REF_TIME_SCALE (the SAME constant batSec uses) —
 *     a FIXED per-salvo interval, not `sucSec/salvos` and not a clamped 50–140 ms.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';
import {getWeapon, WEAPON_DATABASE} from '../src/core/CWeapon';
import {REF_TIME_SCALE} from '../src/core/CShot';

const idOf = (id: string) => WEAPON_DATABASE.findIndex(w => w.id === id);

// Chosen for clean introspection: neither carries muzzle smoke, so the ONLY scheduled
// timers after a shot are the succession salvos themselves (smoke would add 0.06s timers).
const STINGERS = idOf('stingers'); // spawn 6, sucNum 0 — a pure fan
const HELLFIRE = idOf('hellfire'); // spawn 1, sucNum 9, sucSec 2 — a pure succession stream
const KATYUSHA = idOf('katyusha'); // spawn 2 AND sucNum > 0 — a fresh fan per succession salvo

// The machine-gun family, whose identity IS its cadence.
const MACHINE_GUN = idOf('machine.gun');
const MINIGUN = idOf('minigun'); // the same stream, fanned wider and tightened up

// Both thresholds the burst has to clear are module-private where they live:
// CGameController's `SUCCESSION_LOUD_MAX_SEC` (reference units) and CSoundManager's
// `RETRIGGER_MS` same-name retrigger guard.
const LOUD_MAX_SUC_SEC = 0.5;
const RETRIGGER_SEC = 0.045;

/** A fresh match with a human at index 0 and free-fire on (every weapon selectable). */
function fireGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  gc.setWeaponTest(true); // unlimited ammo → any weapon is selectable/fireable
  return gc;
}

/** The multi-fire stats as the ENGINE sees them. weapons.json omits any column holding its
 *  default, so a row is read through CWeapon's getters (spawn defaults to 1, the rest to 0)
 *  rather than off the raw record, where an omitted `spawn` reads as undefined. */
function multiFire(index: number): {spawn: number; sucNum: number; sucSec: number} {
  const w = getWeapon(index);
  return {spawn: w.getSpawnCount(), sucNum: w.getSuccessionCount(), sucSec: w.getSuccessionSec()};
}

/** Delays (relative to now) of every currently-scheduled timer, ascending. */
function pendingDelays(gc: CGameController): number[] {
  const p = priv(gc);
  return p.m_timers.map(t => t.at - p.m_time).sort((a, b) => a - b);
}

describe('Multi-fire cadence', () => {
  it('a spawn weapon fires its whole fan in one frame (no over-time salvos)', () => {
    const gc = fireGame();
    const def = multiFire(STINGERS);
    gc.selectWeapon(STINGERS);
    gc.fire();

    // All `spawn` rounds are airborne immediately; nothing is queued for later.
    expect(priv(gc).m_shots.length).toBe(def.spawn);
    expect(priv(gc).m_pendingSalvos).toBe(0); // its one salvo already fired → none remain
    expect(pendingDelays(gc)).toEqual([]); // no succession timers
  });

  it('a succession weapon fires salvo 0 now and queues the rest sequentially', () => {
    const gc = fireGame();
    const def = multiFire(HELLFIRE);
    gc.selectWeapon(HELLFIRE);
    gc.fire();

    // Only salvo 0's fan is out; the other `sucNum` salvos are still pending — they do
    // NOT all leave at once (the failure this guards: a simultaneous fan of sucNum+1).
    expect(priv(gc).m_shots.length).toBe(def.spawn);
    expect(priv(gc).m_pendingSalvos).toBe(def.sucNum); // 1+sucNum set, salvo 0 already fired
    expect(pendingDelays(gc).length).toBe(def.sucNum);
  });

  it('succession salvos are spaced sucSec·REF_TIME_SCALE apart (fixed, not divided/clamped)', () => {
    const gc = fireGame();
    const def = multiFire(HELLFIRE);
    gc.selectWeapon(HELLFIRE);
    gc.fire();

    const gap = def.sucSec * REF_TIME_SCALE; // ≈ 0.131s for hellfire
    const expected = Array.from({length: def.sucNum}, (_, k) => gap * (k + 1));
    const delays = pendingDelays(gc);
    delays.forEach((d, k) => expect(d).toBeCloseTo(expected[k], 4));

    // And it is genuinely a fixed gap — distinct from either way of deriving one from the salvo
    // count, both of which would land elsewhere.
    const salvos = 1 + def.sucNum;
    expect(gap).not.toBeCloseTo(def.sucSec / salvos, 2); // not sucSec/salvos (0.2)
    expect(gap).not.toBeCloseTo(0.14, 2); // not a clamped spacing (clamp(0.2,.05,.14)=0.14)
  });

  it('a fan + succession weapon fires the WHOLE fan on every salvo', () => {
    const gc = fireGame();
    const def = multiFire(KATYUSHA);
    gc.selectWeapon(KATYUSHA);
    gc.fire();

    // The Katyusha's identity is `spawn` rockets per volley, `sucNum+1` volleys deep — the
    // two multiply. A salvo that dropped back to a single round (or a fan that fired the
    // whole rack at once) would land on `spawn` total rockets either way, so step the clock
    // through every salvo and count.
    expect(priv(gc).m_shots.length).toBe(def.spawn); // volley 0's pair, not the whole rack
    const gap = def.sucSec * REF_TIME_SCALE;
    for (let k = 0; k < def.sucNum; k++) gc.update(gap + 0.001);
    expect(priv(gc).m_pendingSalvos).toBe(0);
    expect(priv(gc).m_shots.length).toBe(def.spawn * (1 + def.sucNum)); // the whole rack
  });

  it('the Minigun outruns the Machine Gun without dropping out of the audible-burst band', () => {
    const mini = multiFire(MINIGUN);
    const mg = multiFire(MACHINE_GUN);

    // Its whole premise: the Machine Gun's stream, fanned wider and cycling faster.
    expect(mini.spawn).toBeGreaterThan(mg.spawn);
    expect(mini.sucSec).toBeLessThan(mg.sucSec);

    // But NOT so fast that the burst goes quiet. At or below `SUCCESSION_LOUD_MAX_SEC` the
    // fire path stops re-barking the report and muzzle flash after the opener, so the
    // remaining salvos — most of the rounds — would fly silent and flashless; and a gap
    // under the sound manager's retrigger guard would swallow the barks it does ask for.
    // Rebalancing `sucSec` downward is exactly the change that trips this silently.
    expect(mini.sucSec).toBeGreaterThan(LOUD_MAX_SUC_SEC);
    expect(mini.sucSec * REF_TIME_SCALE).toBeGreaterThan(RETRIGGER_SEC);
  });

  it('advancing sim time releases the queued salvos one at a time', () => {
    const gc = fireGame();
    const def = multiFire(HELLFIRE);
    gc.selectWeapon(HELLFIRE);
    gc.fire();

    const gap = def.sucSec * REF_TIME_SCALE;
    const salvosLeft0 = priv(gc).m_pendingSalvos;
    // Step a hair past the first gap; exactly one more salvo should have fired.
    gc.update(gap + 0.001);
    expect(priv(gc).m_pendingSalvos).toBe(salvosLeft0 - 1);
  });
});
