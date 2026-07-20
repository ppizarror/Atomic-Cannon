/**
 * Colour math shared across the renderers. Hex decode was duplicated in App, CTank
 * (`hueOf`) and CParticleSystem (`parseColor`); the byte-clamp encode lived in CWeapon
 * (`hex`); the HSL pair lived in CTank. One home for all of it.
 */

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
    const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
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

/** RGB (0..255) → HSL, each component 0..1. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = 0;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
}

/** HSL (each 0..1) → RGB (0..255, rounded). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hk = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [Math.round(hk(h + 1 / 3) * 255), Math.round(hk(h) * 255), Math.round(hk(h - 1 / 3) * 255)];
}

/** Hue (0..1) of a `#rrggbb` colour. */
export function hueOf(hex: string): number {
    const {r, g, b} = hexToRgb(hex);
    return rgbToHsl(r, g, b)[0];
}
