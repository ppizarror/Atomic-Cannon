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
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {REF_TIME_SCALE} from '../src/core/CShot';

const idOf = (id: string) => WEAPON_DATABASE.findIndex(w => w.id === id);

// Chosen for clean introspection: neither carries muzzle smoke, so the ONLY scheduled
// timers after a shot are the succession salvos themselves (smoke would add 0.06s timers).
const STINGERS = idOf('stingers'); // spawn 6, sucNum 0 — a pure fan
const HELLFIRE = idOf('hellfire'); // spawn 1, sucNum 9, sucSec 2 — a pure succession stream
const KATYUSHA = idOf('katyusha'); // spawn 2 AND sucNum > 0 — a fresh fan per succession salvo

/** A fresh match with a human at index 0 and free-fire on (every weapon selectable). */
function fireGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  gc.setWeaponTest(true); // unlimited ammo → any weapon is selectable/fireable
  return gc;
}

/** Delays (relative to now) of every currently-scheduled timer, ascending. */
function pendingDelays(gc: CGameController): number[] {
  const p = priv(gc);
  return p.m_timers.map(t => t.at - p.m_time).sort((a, b) => a - b);
}

describe('Multi-fire cadence', () => {
  it('a spawn weapon fires its whole fan in one frame (no over-time salvos)', () => {
    const gc = fireGame();
    const def = WEAPON_DATABASE[STINGERS];
    gc.selectWeapon(STINGERS);
    gc.fire();

    // All `spawn` rounds are airborne immediately; nothing is queued for later.
    expect(priv(gc).m_shots.length).toBe(def.spawn);
    expect(priv(gc).m_pendingSalvos).toBe(0); // its one salvo already fired → none remain
    expect(pendingDelays(gc)).toEqual([]); // no succession timers
  });

  it('a succession weapon fires salvo 0 now and queues the rest sequentially', () => {
    const gc = fireGame();
    const def = WEAPON_DATABASE[HELLFIRE];
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
    const def = WEAPON_DATABASE[HELLFIRE];
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
    const def = WEAPON_DATABASE[KATYUSHA];
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

  it('advancing sim time releases the queued salvos one at a time', () => {
    const gc = fireGame();
    const def = WEAPON_DATABASE[HELLFIRE];
    gc.selectWeapon(HELLFIRE);
    gc.fire();

    const gap = def.sucSec * REF_TIME_SCALE;
    const salvosLeft0 = priv(gc).m_pendingSalvos;
    // Step a hair past the first gap; exactly one more salvo should have fired.
    gc.update(gap + 0.001);
    expect(priv(gc).m_pendingSalvos).toBe(salvosLeft0 - 1);
  });
});
