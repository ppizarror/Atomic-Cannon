/**
 * Render interpolation: the sim is locked to a fixed 60 Hz (CGameController.FIXED_DT) so a shot
 * resolves in the same number of steps on every client, but the DISPLAY may refresh at 120 Hz or
 * more. Drawn straight off the sim state, a projectile then holds the same position for two frames
 * out of every three and judders at a rock-steady 120 fps — and worse than a clean 60 Hz would,
 * because the accumulator's leftover drifts against a jittering rAF clock and the steps land in
 * irregular runs.
 *
 * So draw() samples `renderAlpha()` — how far real time has advanced from the previous fixed step
 * toward the current one — and paints the fast-moving visuals at that point between the two states
 * the sim actually computed. These tests pin the three things that has to get right: it really does
 * move every frame, the camera moves WITH it (only their relative motion is visible), and a camera
 * TELEPORT snaps instead of sliding across the map.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import {CCamera, CAMERA} from '../src/game/CCamera';
import {CShot} from '../src/core/CShot';
import {Vec2} from '../src/math/Vec2';
import {priv} from './_internals';

const FIXED_DT = 1 / 60;
const bounds = {worldWidth: 4000, viewW: 900, viewH: 600};

describe('CShot.renderPosition', () => {
  /** A shot mid-flight: one full step taken, so prevPos and pos straddle a real segment. */
  function stepped(): CShot {
    const s = new CShot();
    s.initFromVelocity(new Vec2(100, 200), 600, 0, 10, 20, null);
    s.update(FIXED_DT, new Vec2(0, 0));
    return s;
  }

  it('walks the segment the sim just stepped through', () => {
    const s = stepped();
    const prev = s.getPrevPosition();
    const cur = s.getPosition();
    expect(cur.x).toBeGreaterThan(prev.x); // the step actually moved it

    expect(s.renderPosition(0).x).toBeCloseTo(prev.x, 6);
    expect(s.renderPosition(1).x).toBeCloseTo(cur.x, 6);
    expect(s.renderPosition(0.5).x).toBeCloseTo((prev.x + cur.x) / 2, 6);
    expect(s.renderPosition(0.25).y).toBeCloseTo(prev.y + (cur.y - prev.y) * 0.25, 6);
  });

  it('never runs past the current sim position — it interpolates, it does not extrapolate', () => {
    // The whole reason for lagging a step: the sprite can't be drawn inside terrain the shot has
    // not reached and then snap back when the collision resolves.
    const s = stepped();
    const cur = s.getPosition();
    for (let a = 0; a <= 1.0001; a += 0.05) {
      expect(s.renderPosition(a).x).toBeLessThanOrEqual(cur.x + 1e-9);
    }
  });

  it('defaults to the raw sim position, so a non-interpolating caller is unaffected', () => {
    const s = stepped();
    // draw()'s alpha defaults to 1 — that IS renderPosition(1).
    expect(s.renderPosition(1).x).toBeCloseTo(s.getPosition().x, 6);
  });

  it('sits still on a freshly fired shot (prev seeded to pos — nothing to interpolate yet)', () => {
    const s = new CShot();
    s.initFromVelocity(new Vec2(100, 200), 600, 0, 10, 20, null);
    expect(s.renderPosition(0).x).toBe(100);
    expect(s.renderPosition(1).x).toBe(100);
  });
});

describe('CCamera render interpolation', () => {
  /** A camera mid-pan: far-away target, one step taken. */
  function panning(): CCamera {
    const c = new CCamera();
    c.centerOn(0, bounds);
    c.update(FIXED_DT, 3000, true, bounds); // follow far right → a full-speed step
    return c;
  }

  it('walks the scroll the sim just stepped through', () => {
    const c = panning();
    const x = c.x();
    expect(x).toBeCloseTo(CAMERA.SCROLL_SPEED * FIXED_DT, 6); // one step of pan, from 0
    expect(c.xAt(0)).toBeCloseTo(0, 6);
    expect(c.xAt(1)).toBeCloseTo(x, 6);
    expect(c.xAt(0.5)).toBeCloseTo(x / 2, 6);
  });

  it('holds the render gate open until the DRAWN scroll catches up with the sim', () => {
    const c = panning();
    // The pan moved this step, so a frame drawn now is still short of c.x() — the gate has to keep
    // presenting or the world is stranded there while clicks map through the sim position.
    expect(c.isInterpolating()).toBe(true);

    // Settle on target, then one more step with nothing left to move: caught up, gate may close.
    for (let i = 0; i < 500 && c.isPanning(); i++) c.update(FIXED_DT, 3000, true, bounds);
    c.update(FIXED_DT, 3000, true, bounds);
    expect(c.isInterpolating()).toBe(false);
    expect(c.xAt(0)).toBeCloseTo(c.x(), 6); // any alpha now draws the settled position
  });

  it('snaps on a teleport instead of sliding across the map', () => {
    // centerOn (battle start / turn hand-off) and a minimap drag are instant by design. If they
    // left m_prevX behind, the next frames would lerp the whole world across from the old view.
    const c = panning();
    c.centerOn(2000, bounds);
    expect(c.isInterpolating()).toBe(false);
    expect(c.xAt(0)).toBeCloseTo(c.x(), 6);

    const r = c.rect(bounds);
    expect(c.panFrom(r.m + r.width * 0.75, bounds)).toBe(true);
    expect(c.isInterpolating()).toBe(false);
    expect(c.xAt(0)).toBeCloseTo(c.x(), 6);

    c.reset();
    expect(c.isInterpolating()).toBe(false);
    expect(c.xAt(0)).toBe(0);
  });
});

describe('a 120 Hz display gets 120 distinct projectile positions', () => {
  it('advances the drawn shot every frame, not every other one', () => {
    const gc = new CGameController(makeCanvas(900, 600));
    gc.setHumanCount(1);
    gc.startGame(2);
    const p = priv(gc);

    // Steep and at full power, so the round is still climbing for the whole sampled window — this
    // test is about the flight, and a detonation would drag the blast/terrain path in with it.
    gc.setAngle(75);
    gc.setPower(1000);
    gc.fire();
    const shot = p.m_shots[0];
    expect(shot, 'a shot should be in flight after fire()').toBeTruthy();

    // Prime one full step. The render trails the sim by design, so until the first step lands
    // prev == pos and the round sits at the muzzle — a real (and correct) startup frame, but not
    // what this test is about.
    gc.advance(FIXED_DT);

    // Drive the loop at a 120 Hz display's cadence. advance() takes a sim step on roughly every
    // OTHER frame — that is the whole point — so the raw sim position is unchanged half the time.
    const drawn: number[] = [];
    const sim: number[] = [];
    for (let f = 0; f < 24; f++) {
      gc.advance(1 / 120);
      expect(shot.isDead(), 'the round should stay airborne for the sampled window').toBe(false);
      drawn.push(shot.renderPosition(p.renderAlpha()).x);
      sim.push(shot.getPosition().x);
    }

    // The raw sim position repeats — the judder being fixed.
    const simRepeats = sim.filter((x, i) => i > 0 && x === sim[i - 1]).length;
    expect(simRepeats, 'the 60 Hz sim should hold still on some frames').toBeGreaterThan(0);

    // The DRAWN position never does, and only ever moves forward.
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i], `frame ${i} repeated frame ${i - 1}`).not.toBe(drawn[i - 1]);
      expect(drawn[i]).toBeGreaterThan(drawn[i - 1]);
    }

    // And it moves in EVEN increments: the artifact being fixed is not just "it stopped", it is
    // the 0-then-double sawtooth. Half a step's travel either way is generous; a stalled frame
    // followed by a doubled one would blow straight through it.
    const steps = drawn.slice(1).map((x, i) => x - drawn[i]);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const s of steps) expect(Math.abs(s - mean)).toBeLessThan(mean * 0.5);
  });
});
