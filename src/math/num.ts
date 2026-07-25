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

/** Degrees → radians. */
export const deg2rad = (deg: number): number => deg * DEG;

/** Radians → degrees. */
export const rad2deg = (rad: number): number => rad / DEG;

/**
 * Wrap `i` into [0, n) with correct behaviour for negatives — `((i % n) + n) % n`.
 * Works for angles (`wrapIndex(deg, 360)`) and list indices alike.
 */
export const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;
