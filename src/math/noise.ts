/**
 * Value noise on an integer lattice — the fuzz behind blast decals (scorch falloff, the churned
 * soil coat's mixing zone).
 *
 * Deliberately NOT seeded: these are keyed to WORLD coordinates, so every blast that touches a
 * spot agrees on its value and overlapping decals merge into one continuous pattern instead of
 * reading as stacked stamps. That also makes them free of state — no generator to thread through,
 * and identical on every client without syncing anything.
 */

import {lerp, smoothstep} from './num';

/** Deterministic 0..1 hash of a lattice point. Doubles as per-pixel white noise when called with
 *  pixel coordinates — a dither that flips each pixel independently, which is what makes two
 *  materials interleave grain by grain instead of meeting along a contour. */
export function hashLattice(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise (0..1) sampled on a `cell`-px lattice — soft blotches rather than per-pixel
 *  speckle. Bilinear between lattice points, smoothstepped so there are no creases along them. */
export function blotchNoise(x: number, y: number, cell: number): number {
  const fx = x / cell,
    fy = y / cell;
  const ix = Math.floor(fx),
    iy = Math.floor(fy);
  const tx = smoothstep(fx - ix),
    ty = smoothstep(fy - iy);
  const a = hashLattice(ix, iy),
    b = hashLattice(ix + 1, iy),
    c = hashLattice(ix, iy + 1),
    d = hashLattice(ix + 1, iy + 1);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}
