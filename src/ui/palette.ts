/**
 * Colour-palette helpers for the Customize Players picker: load the rainbow
 * `color pallette.bmp` into an offscreen canvas so a click can be sampled to an RGB,
 * and recolour a tank sprite to a chosen colour for the live preview (the same
 * luminance-modulated recolour the engine applies to hulls).
 */
import {makeCanvas2d} from '../util/canvas';
import {clamp} from '../math/num';

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
      const {cv, ctx: g} = makeCanvas2d(img.width, img.height, {willReadFrequently: true});
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
  const x = clamp(Math.round(fx * (data.width - 1)), 0, data.width - 1);
  const y = clamp(Math.round(fy * (data.height - 1)), 0, data.height - 1);
  const i = (y * data.width + x) * 4;
  return toHex(data.data[i], data.data[i + 1], data.data[i + 2]);
}

/**
 * Fractional coords (fx, fy ∈ 0..1) of the palette pixel closest to `hex` — used to
 * place the selection crosshair, so even a stored/default colour shows where it sits
 * on the bar.
 */
export function findNearestInPalette(data: ImageData, hex: string): {fx: number; fy: number} {
  const n = parseInt(hex.slice(1), 16);
  const tr = (n >> 16) & 0xff,
    tg = (n >> 8) & 0xff,
    tb = n & 0xff;
  const {width: w, height: h, data: px} = data;
  let best = Infinity,
    bx = 0,
    by = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = px[i] - tr,
        dg = px[i + 1] - tg,
        db = px[i + 2] - tb;
      const d = dr * dr + dg * dg + db * db;
      if (d < best) {
        best = d;
        bx = x;
        by = y;
      }
    }
  }
  return {fx: w > 1 ? bx / (w - 1) : 0, fy: h > 1 ? by / (h - 1) : 0};
}

const lumaOf = (r: number, g: number, b: number): number => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

// The sprite bitmaps carry an opaque colour-key background (no alpha); the top-left
// corner pixel is the key. Matches CAssetManager's tolerance.
const KEY_TOLERANCE = 24;

// Recolour a loaded sprite to `hex` onto its own canvas (brightest pixel → the exact
// colour, darker pixels → proportional shades), first knocking out the colour-key
// background to transparency so the preview has no box. Shared by hull + turret.
async function recolorToCanvas(url: string, hex: string): Promise<HTMLCanvasElement> {
  const img = await loadImage(url);
  const {cv, ctx: g} = makeCanvas2d(img.width, img.height, {willReadFrequently: true});
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, cv.width, cv.height);
  const px = im.data;
  const n = parseInt(hex.slice(1), 16);
  const tr = (n >> 16) & 0xff,
    tg = (n >> 8) & 0xff,
    tb = n & 0xff;
  // Key colour = the corner pixel; zero the alpha of every pixel within tolerance.
  const [kr, kg, kb] = [px[0], px[1], px[2]];
  for (let i = 0; i < px.length; i += 4) {
    if (
      Math.abs(px[i] - kr) <= KEY_TOLERANCE &&
      Math.abs(px[i + 1] - kg) <= KEY_TOLERANCE &&
      Math.abs(px[i + 2] - kb) <= KEY_TOLERANCE
    ) {
      px[i + 3] = 0;
    }
  }
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
  return cv;
}

// Draw proportions mirror the engine (hull width 46, turret length 20, pivot 15px above
// the ground line, default aim 45° up-right); ×S for a crisp preview bitmap.
const PV = {S: 3, hullW: 46, turLen: 20, pivotUp: 15};

/**
 * Composite a tank's recoloured hull + turret (barrel angled up-right, as in play) to
 * a data URL for the Customize Players preview.
 */
export async function recolorTankPreview(model: string, hex: string): Promise<string> {
  const [body, turret] = await Promise.all([
    recolorToCanvas(`/assets/tanks/${model} body.bmp`, hex),
    recolorToCanvas(`/assets/tanks/${model} turret.bmp`, hex),
  ]);
  const {S, hullW, turLen, pivotUp} = PV;
  const bw = hullW * S;
  const bh = (body.height / body.width) * bw;
  const tl = turLen * S;
  const tt = (turret.height / turret.width) * tl;

  const {cv, ctx: g} = makeCanvas2d(150, 110);
  g.imageSmoothingEnabled = false;
  const cx = cv.width / 2;
  const groundY = cv.height - 6;

  // Turret first (base at the hull-top pivot, pointing up-right) so the hull overlaps
  // its root; then the hull on top.
  g.save();
  g.translate(cx, groundY - pivotUp * S);
  g.rotate(-Math.PI / 4); // 45° up-right (screen y is down)
  g.drawImage(turret, 0, -tt / 2, tl, tt);
  g.restore();
  g.drawImage(body, cx - bw / 2, groundY - bh, bw, bh);
  return cv.toDataURL();
}
