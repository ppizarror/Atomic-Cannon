/**
 * PixelBlitter — a reusable scratch canvas for drawing a cloud of 1px points in ONE call.
 *
 * A blast throws thousands of dirt chunks / debris specks. Painting each with `fillRect` is
 * thousands of canvas calls per frame; plotting them into an ImageData and blitting once is a
 * handful. The bookkeeping that makes that cheap — grow the scratch canvas instead of
 * reallocating, only rebuild the ImageData when the size actually changes, reuse the same 32-bit
 * view — was written out twice, in CParticleSystem's debris draw and CLand's dirt-spray draw.
 *
 * Callers keep their own fallback (both bail to per-pixel `fillRect` when headless or when the
 * cloud is spread so wide the buffer would cost more than the calls it saves) because the pixel
 * colour rules differ; only the buffer management lives here.
 */
export class PixelBlitter {
  private m_cv: HTMLCanvasElement | null = null;
  private m_img: ImageData | null = null;
  private m_ctx: CanvasRenderingContext2D | null = null;

  /**
   * Prepare a transparent `dw`×`dh` buffer and return a 32-bit view to plot into (one `0xAABBGGRR`
   * word per pixel, row-major). Null when there is no DOM or no 2D context — the caller falls back
   * to per-pixel draws. Transparent, not opaque: whatever is already on the scene must show through
   * the gaps in the cloud.
   */
  begin(dw: number, dh: number): Uint32Array | null {
    const bytes = this.beginBytes(dw, dh);
    return bytes ? new Uint32Array(bytes.buffer) : null;
  }

  /**
   * {@link begin} as the raw RGBA BYTE view. Plotting a packed word per pixel is the common case,
   * but a cloud whose grains ADD into each other (the fallout specks, which saturate per channel)
   * has to read and write the channels individually.
   */
  beginBytes(dw: number, dh: number): Uint8ClampedArray | null {
    if (typeof document === 'undefined') return null;
    let cv = this.m_cv;
    if (!cv) cv = this.m_cv = document.createElement('canvas');
    if (cv.width < dw || cv.height < dh) {
      // Grow only — a shrink would churn the backing store every time a cloud narrows.
      cv.width = Math.max(cv.width, dw);
      cv.height = Math.max(cv.height, dh);
      this.m_img = null; // the old ImageData no longer matches the canvas
    }
    const g = cv.getContext('2d');
    if (!g) return null;
    this.m_ctx = g;
    if (!this.m_img || this.m_img.width !== dw || this.m_img.height !== dh) {
      this.m_img = g.createImageData(dw, dh);
    }
    this.m_img.data.fill(0);
    return this.m_img.data;
  }

  /** Blit the buffer prepared by {@link begin} onto `ctx` with its top-left at (dx, dy). */
  end(ctx: CanvasRenderingContext2D, dw: number, dh: number, dx: number, dy: number): void {
    if (!this.m_ctx || !this.m_img || !this.m_cv) return;
    this.m_ctx.putImageData(this.m_img, 0, 0);
    ctx.drawImage(this.m_cv, 0, 0, dw, dh, dx, dy, dw, dh);
  }
}
