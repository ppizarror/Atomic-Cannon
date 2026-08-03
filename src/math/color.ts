/**
 * Colour math shared across the renderers. Hex decode was duplicated in App, CTank
 * and CParticleSystem (`parseColor`); the byte-clamp encode lived in CWeapon (`hex`).
 * One home for all of it.
 */
import {clamp} from './num';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const WHITE: RGB = {r: 255, g: 255, b: 255};

/** Decode `#rrggbb` → RGB. Assumes a valid 7-char hex; callers needing a fallback
 *  should gate with a validity check (see CParticleSystem.parseColor). */
export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return {r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff};
}

/** Encode RGB → `#rrggbb`, clamping/rounding each channel into a byte. */
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Perceptual luminance of a pixel, 0..1 (Rec. 601 weights).
 *
 * The luminance-modulated recolour is done in two places — the engine's hull tint (CTank) and the
 * Customize Players preview (ui/palette), which must produce the same shading or the preview stops
 * matching the tank it previews — so the weights live here rather than in either of them.
 */
export function luma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Brightest {@link luma} among the OPAQUE pixels of an RGBA buffer — the normaliser both
 * luminance-modulated recolours divide by, so the sprite's own brightest pixel maps to exactly the
 * chosen colour and everything darker to a proportional shade. Floored just above zero so an
 * all-black sprite can't divide by 0.
 */
export function maxOpaqueLuma(px: Uint8ClampedArray): number {
  let max = 0.001;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const l = luma(px[i], px[i + 1], px[i + 2]);
    if (l > max) max = l;
  }
  return max;
}

/** Mix each channel of `c` toward `target` by `t` (0..1). */
export function mixToward(c: RGB, target: RGB, t: number): RGB {
  return {
    r: c.r + (target.r - c.r) * t,
    g: c.g + (target.g - c.g) * t,
    b: c.b + (target.b - c.b) * t,
  };
}
