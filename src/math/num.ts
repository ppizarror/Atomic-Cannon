/**
 * Scalar math helpers shared across the game. Previously `clamp` was defined three
 * times (Hud, CBotAI, CLand) and inlined ~30 more as `Math.max(lo, Math.min(hi, v))`;
 * likewise deg↔rad, index wrap, and `Math.PI * 2`. One home for all of them.
 */

export const TWO_PI = Math.PI * 2;

const DEG = Math.PI / 180;

/** Clamp `v` into the inclusive range [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Clamp `v` into [0, 1]. */
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * {@link clamp} for a range that may be INVERTED (`hi < lo`) — it clamps to `lo` rather than
 * letting the upper bound win. Plain `clamp` returns `hi` there, which is the wrong end.
 *
 * For layout maths where the bounds are computed from a measured size: a tooltip wider than the
 * viewport, or a track shorter than its own margins, yields `hi < lo`, and pinning to the near
 * edge keeps the element on screen instead of pushing it off the far one.
 */
export const clampSafe = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Degrees → radians. */
export const deg2rad = (deg: number): number => deg * DEG;

/** Radians → degrees. */
export const rad2deg = (rad: number): number => rad / DEG;

/**
 * Wrap `i` into [0, n) with correct behaviour for negatives — `((i % n) + n) % n`.
 * Works for angles (`wrapIndex(deg, 360)`) and list indices alike.
 */
export const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

/** Linear interpolation from `a` to `b` at `t` (unclamped). */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Hermite ease `3t² − 2t³` on an ALREADY-normalised `t` — flat at both 0 and 1, so a value eased
 * through it arrives and departs without a visible crease. Inlined as `t * t * (3 - 2 * t)` at four
 * sites in CLand alone (noise interpolation, coat coverage, scorch falloff).
 */
export const smoothstep = (t: number): number => t * t * (3 - 2 * t);
