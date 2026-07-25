/**
 * Colour-key transparency: zero the alpha of every RGBA pixel where `matches(px, i)` holds
 * (`px` = the ImageData byte array, `i` = the pixel's 4-byte offset). The `for (i += 4)`
 * knockout scan that the bitmap-font parser, the sprite colour-keyer and the UI bmp loader
 * each hand-wrote. Runs at load time only, so a per-pixel predicate call is fine.
 */
export function knockoutWhere(
  px: Uint8ClampedArray,
  matches: (px: Uint8ClampedArray, i: number) => boolean,
): void {
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
