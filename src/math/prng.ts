/**
 * Deterministic, serializable pseudo-random generator — the single source of
 * *gameplay* randomness once the game is networked.
 *
 * A small linear congruential generator whose entire state is one uint32. That
 * makes a match reproducible from a seed and lets a snapshot capture/restore the
 * RNG cursor exactly (needed for lockstep multiplayer, replays, and tests). It
 * matches the generator `CLand` already uses for terrain, so the two stay in step.
 *
 * Scope: gameplay only. Purely cosmetic randomness (particles, weather, taunts,
 * fireworks) must NOT draw from a shared `Prng`, or differing local frame rates
 * would desync the shared stream. Those keep `Math.random` (or their own
 * throwaway `Prng`). See `src/math/random.ts`.
 */
export class Prng {
  private m_state: number;

  constructor(seed: number = 1) {
    this.m_state = seed >>> 0 || 1;
  }

  /** Reseed. Zero is remapped to 1 so the stream never collapses. */
  seed(seed: number): void {
    this.m_state = seed >>> 0 || 1;
  }

  /** The full serializable RNG cursor (a single uint32). */
  getState(): number {
    return this.m_state >>> 0;
  }

  /** Restore a cursor captured with {@link getState}. */
  setState(state: number): void {
    this.m_state = state >>> 0 || 1;
  }

  /** Next integer in 0..32767. */
  nextRand(): number {
    this.m_state = (Math.imul(this.m_state, 0x343fd) + 0x269ec3) >>> 0;
    return (this.m_state >>> 16) & 0x7fff;
  }

  float(): number {
    return this.nextRand() / 0x8000;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Uniform integer in 0..n-1 (n <= 0 → 0). */
  int(n: number): number {
    return n <= 0 ? 0 : Math.floor(this.float() * n);
  }

  /** Uniform integer in [min, max] inclusive. */
  rangeInt(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** Symmetric jitter: uniform in [-x, x). */
  plusMinus(x: number): number {
    return (this.float() * 2 - 1) * x;
  }

  /** -1 or +1 with equal probability. */
  sign(): number {
    return this.float() < 0.5 ? -1 : 1;
  }

  /** True with probability p (default 0.5). */
  bool(p: number = 0.5): boolean {
    return this.float() < p;
  }

  /**
   * True with a percentage chance in [0, 100]. Mirrors the common
   * `Math.random() * 100 < pct` gate used across the controller.
   */
  chance(pct: number): boolean {
    return this.float() * 100 < pct;
  }

  /** A uniformly-chosen element (undefined for an empty array). */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
}
