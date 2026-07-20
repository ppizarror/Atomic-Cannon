/**
 * Colour-palette helpers for the Customize Players picker: load the rainbow
 * `color pallette.bmp` into an offscreen canvas so a click can be sampled to an RGB,
 * and recolour a tank sprite to a chosen colour for the live preview (the same
 * luminance-modulated recolour the engine applies to hulls).
 */

const PALETTE_URL = '/assets/gui/color pallette.bmp';

let paletteData: ImageData | null = null;
let paletteLoading: Promise<ImageData | null> | null = null;

const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Load (once) the palette bitmap as ImageData for pixel sampling. */
export function loadPalette(): Promise<ImageData | null> {
  if (paletteData) return Promise.resolve(paletteData);
  if (paletteLoading) return paletteLoading;
  paletteLoading = loadImage(PALETTE_URL)
    .then(img => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const g = cv.getContext('2d', {willReadFrequently: true})!;
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0);
      paletteData = g.getImageData(0, 0, cv.width, cv.height);
      return paletteData;
    })
    .catch(() => null);
  return paletteLoading;
}

/** Sample the palette at fractional coords (fx, fy ∈ 0..1) → '#rrggbb'. */
export function samplePalette(data: ImageData, fx: number, fy: number): string {
  const x = Math.min(data.width - 1, Math.max(0, Math.round(fx * (data.width - 1))));
  const y = Math.min(data.height - 1, Math.max(0, Math.round(fy * (data.height - 1))));
  const i = (y * data.width + x) * 4;
  return toHex(data.data[i], data.data[i + 1], data.data[i + 2]);
}

const lumaOf = (r: number, g: number, b: number): number =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/**
 * Recolour a loaded tank sprite to `hex` (brightest pixel → the exact colour, darker
 * pixels → proportional shades) and return a data URL for an <img> preview.
 */
export async function recolorTank(url: string, hex: string): Promise<string> {
  const img = await loadImage(url);
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const g = cv.getContext('2d', {willReadFrequently: true})!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, cv.width, cv.height);
  const px = im.data;
  const n = parseInt(hex.slice(1), 16);
  const tr = (n >> 16) & 0xff,
    tg = (n >> 8) & 0xff,
    tb = n & 0xff;
  let maxL = 0.001;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const l = lumaOf(px[i], px[i + 1], px[i + 2]);
    if (l > maxL) maxL = l;
  }
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const f = Math.min(1, lumaOf(px[i], px[i + 1], px[i + 2]) / maxL);
    px[i] = Math.round(tr * f);
    px[i + 1] = Math.round(tg * f);
    px[i + 2] = Math.round(tb * f);
  }
  g.putImageData(im, 0, 0);
  return cv.toDataURL();
}
