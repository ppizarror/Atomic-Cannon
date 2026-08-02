/**
 * Memoizes colour-tinted copies of a white master sprite, keyed by a coarse 4-bit/channel
 * colour bucket, evicting the OLDEST entry past a cap (a full clear would turn an overflow
 * into a per-frame rebuild storm). The recolour keeps the master's alpha shape and swaps in
 * a solid `source-in` fill. The master is a square `size*2` canvas painted once by `build`.
 * Headless (no DOM, e.g. the unit-test runner) yields null so callers fall back to a live
 * gradient.
 *
 * Shared by CParticleSystem's additive glow and the rocket-exhaust puff — same cache/evict
 * logic, differing only in the master's falloff (the `build` callback) and radius.
 */
import {capSet} from '../../util/cache';
import {recolorOpaque, tryCanvas2d} from '../../util/canvas';
export class TintedSpriteCache {
  private m_master: HTMLCanvasElement | null = null;
  private m_na = false; // no DOM (unit tests) → callers fall back to a gradient
  private readonly m_tints = new Map<number, HTMLCanvasElement>();

  /**
   * @param m_size  master half-size; the master canvas is `size*2` px square.
   * @param m_build paints the white master into `g` (radius `size`), e.g. a radial gradient.
   * @param m_cap   max cached tints before the oldest is evicted.
   */
  constructor(
    private readonly m_size: number,
    private readonly m_build: (g: CanvasRenderingContext2D, size: number) => void,
    private readonly m_cap = 512,
  ) {}

  /** The white master (built once), or null where there's no canvas (headless tests). */
  master(): HTMLCanvasElement | null {
    if (this.m_master || this.m_na) return this.m_master;
    const R = this.m_size;
    const made = tryCanvas2d(R * 2, R * 2);
    if (!made) {
      this.m_na = true; // no DOM / no 2D context — don't retry every frame
      return null;
    }
    this.m_build(made.ctx, R);
    this.m_master = made.cv;
    return made.cv;
  }

  /** The master tinted to (r,g,b), cached by 4-bit/channel colour bucket. Null when headless. */
  tint(r: number, g: number, b: number): HTMLCanvasElement | null {
    const master = this.master();
    if (!master) return null;
    // 4 bits/channel: jittered preset tints collapse to a handful of buckets while genuinely
    // different weapon colours stay apart — the coarser step is invisible on a soft sprite.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const hit = this.m_tints.get(key);
    if (hit) return hit;
    const D = this.m_size * 2;
    const cv = recolorOpaque(master, D, D, `rgb(${r | 0},${g | 0},${b | 0})`);
    capSet(this.m_tints, key, cv, this.m_cap);
    return cv;
  }
}
