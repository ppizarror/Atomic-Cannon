/**
 * Colour-key transparency: zero the alpha of every RGBA pixel where `matches(px, i)` holds
 * (`px` = the ImageData byte array, `i` = the pixel's 4-byte offset). The `for (i += 4)`
 * knockout scan that the bitmap-font parser, the sprite colour-keyer and the UI bmp loader
 * each hand-wrote. Runs at load time only, so a per-pixel predicate call is fine.
 */
export function knockoutWhere(px: Uint8ClampedArray, matches: (px: Uint8ClampedArray, i: number) => boolean): void {
  for (let i = 0; i < px.length; i += 4) {
    if (matches(px, i)) px[i + 3] = 0;
  }
}

/**
 * Create a sized 2D canvas and its context in one call — the `createElement('canvas')` +
 * set width/height + `getContext('2d')` boilerplate that recurs across the renderers.
 * `willReadFrequently` keeps the backing store CPU-side for `getImageData`-heavy canvases.
 * Asserts the context is non-null (always true in a browser); headless code paths that must
 * tolerate a missing 2D context keep their own explicit null-guarded form.
 */
export function makeCanvas2d(
  w: number,
  h: number,
  opts?: CanvasRenderingContext2DSettings,
): {cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D} {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', opts)!;
  return {cv, ctx};
}

/**
 * {@link makeCanvas2d} for the render paths that must survive WITHOUT a DOM — the particle and
 * terrain layers are built lazily during a draw, and the headless unit-test runner has no canvas,
 * so each of those sites opened with its own `typeof document === 'undefined'` guard plus a null
 * check on `getContext`. Returns null in both cases; callers fall back to a live gradient or skip
 * the layer entirely.
 */
export function tryCanvas2d(
  w: number,
  h: number,
  opts?: CanvasRenderingContext2DSettings,
): {cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D} | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', opts);
  return ctx ? {cv, ctx} : null;
}

/**
 * A solid-colour copy of `src` at its native size: every opaque pixel becomes `color` while the
 * sprite's own alpha shape is preserved. `source-in` is what does it — it keeps the DESTINATION
 * alpha (the sprite already drawn) and takes its colour from the incoming fill.
 *
 * Backs both the tank's High-Contrast silhouette and the particle system's colour-bucketed
 * sprite tints, which had hand-written copies of the same four-step dance.
 */
export function recolorOpaque(src: CanvasImageSource, w: number, h: number, color: string): HTMLCanvasElement {
  const {cv, ctx} = makeCanvas2d(w, h);
  ctx.imageSmoothingEnabled = false; // 1:1 blit — no resampling of the source art
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return cv;
}
