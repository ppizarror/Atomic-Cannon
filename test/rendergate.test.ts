/**
 * Logic tests for the present-on-demand render gate.
 */
import {describe, it, expect} from 'vitest';

import {RenderGate} from '../src/game/RenderGate';

const GRACE = 1500;
// A time far past any grace window, so cosmetic-grace never keeps a frame alive
// unless we explicitly interact just before it.
const T = 1_000_000;

describe('RenderGate', () => {
  it('starts dirty so the very first frame always draws', () => {
    const g = new RenderGate(GRACE);
    expect(g.shouldRedraw(false, false, T)).toBe(true);
  });

  it('after the initial draw an idle scene stops redrawing', () => {
    const g = new RenderGate(GRACE);
    expect(g.shouldRedraw(false, false, T)).toBe(true); // frame 0 draws (initial dirty)
    expect(g.shouldRedraw(false, false, T)).toBe(false); // idle frame skips
    expect(g.shouldRedraw(false, false, T)).toBe(false); // stays skipped while idle
  });

  it('markDirty() resumes drawing on the next frame', () => {
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);
    g.shouldRedraw(false, false, T); // settle to idle
    expect(g.shouldRedraw(false, false, T)).toBe(false); // idle
    g.markDirty(T);
    expect(g.shouldRedraw(false, false, T)).toBe(true); // markDirty forces a redraw
  });

  it('gameplay motion always draws and leaves exactly one trailing frame when it stops', () => {
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);
    g.shouldRedraw(false, false, T); // reach idle
    expect(g.shouldRedraw(false, false, T)).toBe(false); // idle before motion
    expect(g.shouldRedraw(false, true, T)).toBe(true); // animating draws
    expect(g.shouldRedraw(false, true, T)).toBe(true); // animating keeps drawing
    expect(g.shouldRedraw(false, false, T)).toBe(true); // motion just stopped → trailing frame draws
    expect(g.shouldRedraw(false, false, T)).toBe(false); // then idle again
  });

  it('cosmetic grace keeps idle frames drawing until the window elapses', () => {
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);
    g.shouldRedraw(false, false, T); // idle baseline (far past grace)
    g.markDirty(10_000); // interact at t=10s
    expect(g.shouldRedraw(false, false, 10_000)).toBe(true); // interaction frame draws
    expect(g.shouldRedraw(false, false, 10_000 + 1000)).toBe(true); // within grace still draws
    expect(g.shouldRedraw(false, false, 10_000 + 1499)).toBe(true); // within grace edge still draws
    expect(g.shouldRedraw(false, false, 10_000 + 1600)).toBe(false); // past grace goes static
  });

  it('paused: draws only on explicit invalidation; motion and grace ignored', () => {
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T); // consume the initial dirty
    expect(g.shouldRedraw(true, true, T)).toBe(false); // paused + clean skips even if animating
    g.markDirty(T);
    expect(g.shouldRedraw(true, false, T)).toBe(true); // paused draws the invalidated frame
    expect(g.shouldRedraw(true, false, T)).toBe(false); // paused then clean skips again
  });
});
