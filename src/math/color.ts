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

/** Mix each channel of `c` toward `target` by `t` (0..1). */
export function mixToward(c: RGB, target: RGB, t: number): RGB {
  return {
    r: c.r + (target.r - c.r) * t,
    g: c.g + (target.g - c.g) * t,
    b: c.b + (target.b - c.b) * t,
  };
}
