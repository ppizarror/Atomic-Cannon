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
