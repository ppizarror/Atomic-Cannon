/**
 * Colour math shared across the renderers. Hex decode was duplicated in App, CTank
 * and CParticleSystem (`parseColor`); the byte-clamp encode lived in CWeapon (`hex`).
 * One home for all of it.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const WHITE: RGB = {r: 255, g: 255, b: 255};
export const BLACK: RGB = {r: 0, g: 0, b: 0};

/** Decode `#rrggbb` → RGB. Assumes a valid 7-char hex; callers needing a fallback
 *  should gate with a validity check (see CParticleSystem.parseColor). */
export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return {r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff};
}

/** Encode RGB → `#rrggbb`, clamping/rounding each channel into a byte. */
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Mix each channel of `c` toward `target` by `t` (0..1). */
export function mixToward(c: RGB, target: RGB, t: number): RGB {
  return {
    r: c.r + (target.r - c.r) * t,
    g: c.g + (target.g - c.g) * t,
    b: c.b + (target.b - c.b) * t,
  };
}

/** Perceived brightness, 0 (black) .. 1 (white). Rec. 601 weights — green reads far brighter
 *  than blue at the same channel value, which is exactly why pure #0000ff looks near-black. */
export function luminance(c: RGB): number {
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

/** Lift `c` toward white until it reaches `min` brightness; already-light colours pass through
 *  untouched. For UI accents drawn over a dark plate, where the team palette's navy / maroon /
 *  purple / pure-blue would otherwise disappear. Mixing toward white moves luminance linearly,
 *  so the needed amount solves directly — no search, and no overshoot on bright colours. */
export function ensureLuminance(c: RGB, min: number): RGB {
  const l = luminance(c);
  if (l >= min) return c;
  return mixToward(c, WHITE, (min - l) / (1 - l));
}
