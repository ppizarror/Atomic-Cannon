/**
 * CanvasQuadSink — draws FX quads onto a 2-D context.
 *
 * The particle system describes every quad it wants drawn — source sprite, sub-rect, destination
 * box, rotation, alpha, tint — and a sink turns that description into draw calls. The GPU
 * compositor is one such sink; this is the other, used headless (tests) and by any host without a
 * compositor. Because both consume the SAME description, how a particle looks is written once in
 * the particle system rather than once per renderer.
 *
 * The one thing canvas2d cannot do that the GPU sink can is tint per draw, so tinted copies of each
 * source are cached here, bucketed 4 bits per channel. That is invisible on soft additive sprites
 * and keeps the cache small enough that a colour-jittered blast reuses a handful of entries.
 */

import {tryCanvas2d} from '../../util/canvas';

/** Colour buckets are 4 bits per channel — 4096 possible, a few dozen in practice. */
const TINT_BITS = 4;
/** Per-source cap; evicting the oldest beats a full clear, which turns an overflow into a
 *  rebuild storm where every frame misses. */
const TINT_CAP = 128;

export class CanvasQuadSink {
  private m_ctx: CanvasRenderingContext2D | null = null;
  private m_layer = -1;
  private m_alpha = -1;
  private m_op: GlobalCompositeOperation = 'source-over';
  private readonly m_tints = new WeakMap<CanvasImageSource, Map<number, HTMLCanvasElement>>();

  /** Point the sink at the context to draw into, for one frame. */
  target(ctx: CanvasRenderingContext2D): void {
    this.m_ctx = ctx;
  }

  /** The canvas already carries the world transform from the caller, so placement is a no-op here.
   *  Only the GPU sink needs to be told where the camera is. */
  setSmokeTransform(): void {}

  smokeBegin(): void {
    // Remember the composite mode the caller had. Normal-blend layers inherit it rather than being
    // forced to source-over — only the additive layer overrides, and it puts this back afterwards.
    this.m_op = this.m_ctx?.globalCompositeOperation ?? 'source-over';
    this.m_layer = -1;
    this.m_alpha = -1;
  }

  smokeEnd(): void {
    const ctx = this.m_ctx;
    if (!ctx) return;
    if (this.m_alpha !== 1) ctx.globalAlpha = 1;
    if (this.m_layer === 2) ctx.globalCompositeOperation = this.m_op;
    this.m_layer = -1;
    this.m_alpha = -1;
  }

  smokeQuad(
    layer: number,
    src: CanvasImageSource | null,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number,
    alpha: number,
    tint = 0xffffff,
  ): void {
    const ctx = this.m_ctx;
    if (!ctx || w <= 0 || h <= 0) return;
    // Quads arrive grouped by layer, so the blend flips a handful of times a frame rather than
    // per quad. Layer 2 (GLOW) is the additive one.
    if (layer !== this.m_layer) {
      ctx.globalCompositeOperation = layer === 2 ? 'lighter' : this.m_op;
      this.m_layer = layer;
    }
    if (alpha !== this.m_alpha) {
      ctx.globalAlpha = alpha;
      this.m_alpha = alpha;
    }
    if (!src) {
      // No sprite available — a host with no working canvas to bake one. Draw the quad as a plain
      // tinted dot so the particle still appears rather than silently vanishing.
      ctx.fillStyle = `rgb(${(tint >> 16) & 0xff},${(tint >> 8) & 0xff},${tint & 0xff})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, w / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const img = tint === 0xffffff ? src : (this.tinted(src, tint) ?? src);
    if (rotation === 0) {
      ctx.drawImage(img, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
      return;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** A copy of `src` multiplied by `tint`, cached per source and colour bucket. `multiply` keeps the
   *  sprite's internal texture; a flat `source-in` fill would replace it with solid colour. */
  private tinted(src: CanvasImageSource, tint: number): HTMLCanvasElement | null {
    const shift = 8 - TINT_BITS;
    const key =
      ((((tint >> 16) & 0xff) >> shift) << (TINT_BITS * 2)) |
      ((((tint >> 8) & 0xff) >> shift) << TINT_BITS) |
      ((tint & 0xff) >> shift);
    let perSrc = this.m_tints.get(src);
    if (!perSrc) {
      perSrc = new Map();
      this.m_tints.set(src, perSrc);
    }
    const hit = perSrc.get(key);
    if (hit) return hit;
    const w = Number((src as HTMLCanvasElement).width) || 0;
    const h = Number((src as HTMLCanvasElement).height) || 0;
    if (!w || !h) return null;
    const made = tryCanvas2d(w, h);
    if (!made) return null;
    const {cv, ctx: g} = made;
    const q = (v: number): number => ((v >> shift) << shift) | (1 << (shift - 1));
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = `rgb(${q((tint >> 16) & 0xff)},${q((tint >> 8) & 0xff)},${q(tint & 0xff)})`;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in'; // multiply floods the box; re-mask to the sprite
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-over';
    if (perSrc.size >= TINT_CAP) perSrc.delete(perSrc.keys().next().value as number);
    perSrc.set(key, cv);
    return cv;
  }
}
