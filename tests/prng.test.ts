/**
 * The deterministic gameplay PRNG: same seed → same stream, state is a single
 * serializable uint32 that round-trips exactly (the property lockstep/replay and
 * snapshot/reconnect rely on), and it reproduces the reference LCG stream.
 */
import {describe, it, expect} from 'vitest';
import {Prng} from '../src/math/prng';

describe('Prng', () => {
  it('is reproducible: equal seeds produce identical streams', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    const seqA = Array.from({length: 50}, () => a.nextRand());
    const seqB = Array.from({length: 50}, () => b.nextRand());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge', () => {
    const a = new Prng(1);
    const b = new Prng(2);
    const seqA = Array.from({length: 20}, () => a.nextRand());
    const seqB = Array.from({length: 20}, () => b.nextRand());
    expect(seqA).not.toEqual(seqB);
  });

  it('reproduces the reference LCG stream', () => {
    const p = new Prng(1);
    let state = 1 >>> 0;
    for (let i = 0; i < 100; i++) {
      state = (Math.imul(state, 0x343fd) + 0x269ec3) >>> 0;
      expect(p.nextRand()).toBe((state >>> 16) & 0x7fff);
    }
  });

  it('state round-trips: capture, advance, restore replays exactly', () => {
    const p = new Prng(999);
    p.nextRand(); // advance off the seed
    const snapshot = p.getState();
    const expected = Array.from({length: 30}, () => p.nextRand());

    // Same generator, restored.
    p.setState(snapshot);
    expect(Array.from({length: 30}, () => p.nextRand())).toEqual(expected);

    // A fresh generator seeded only by restored state (reconnect scenario).
    const q = new Prng(0);
    q.setState(snapshot);
    expect(Array.from({length: 30}, () => q.nextRand())).toEqual(expected);
  });

  it('float/range/int/rangeInt stay within bounds over many draws', () => {
    const p = new Prng(0xc0ffee);
    for (let i = 0; i < 5000; i++) {
      const f = p.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);

      const r = p.range(-3, 7);
      expect(r).toBeGreaterThanOrEqual(-3);
      expect(r).toBeLessThan(7);

      const n = p.int(6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);

      const ri = p.rangeInt(2, 5);
      expect(ri).toBeGreaterThanOrEqual(2);
      expect(ri).toBeLessThanOrEqual(5);
    }
  });

  it('int(0) and empty pick are safe', () => {
    const p = new Prng(7);
    expect(p.int(0)).toBe(0);
    expect(p.int(-4)).toBe(0);
    expect(p.pick([])).toBeUndefined();
  });

  it('seed(0) does not collapse the stream', () => {
    const p = new Prng(0);
    expect(p.getState()).not.toBe(0);
    const first = p.nextRand();
    const second = p.nextRand();
    expect(first === 0 && second === 0).toBe(false);
  });

  it('rangeInt covers its full inclusive span', () => {
    const p = new Prng(42);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(p.rangeInt(1, 6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
