/**
 * Colour-palette helpers for the Customize Players picker: load the rainbow
 * `color pallette.bmp` into an offscreen canvas so a click can be sampled to an RGB,
 * and recolour a tank sprite to a chosen colour for the live preview (the same
 * luminance-modulated recolour the engine applies to hulls).
 *
 * The preview is a live canvas rather than a still image: its barrel tracks the pointer, so the
 * recolour is split from the composite — parts are recoloured once per (hull, colour) and re-drawn
 * at whatever the current aim is.
 */
import {knockoutWhere, makeCanvas2d, nearColor} from '../util/canvas';
import {hexToRgb, luma, maxOpaqueLuma, rgbToHex} from '../math/color';
import {clamp} from '../math/num';
import {capSet} from '../util/cache';
import {PLAYER_TANKS, drawTurretSprite, tankDrawGeometry} from '../core/CTank';

const PALETTE_URL = '/assets/gui/color pallette.bmp';

let paletteData: ImageData | null = null;
let paletteLoading: Promise<ImageData | null> | null = null;

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
  return rgbToHex(data.data[i], data.data[i + 1], data.data[i + 2]);
}

/**
 * Fractional coords (fx, fy ∈ 0..1) of the palette pixel closest to `hex` — used to
 * place the selection crosshair, so even a stored/default colour shows where it sits
 * on the bar.
 */
export function findNearestInPalette(data: ImageData, hex: string): {fx: number; fy: number} {
  const {r: tr, g: tg, b: tb} = hexToRgb(hex);
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
  const {r: tr, g: tg, b: tb} = hexToRgb(hex);
  // These bitmaps carry an opaque colour-key background (no alpha) and the top-left corner pixel
  // IS the key — unlike the sprite loader's fixed magenta, but the same tolerance rule.
  knockoutWhere(px, nearColor(px[0], px[1], px[2]));
  const maxL = maxOpaqueLuma(px);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const f = Math.min(1, luma(px[i], px[i + 1], px[i + 2]) / maxL);
    px[i] = Math.round(tr * f);
    px[i + 1] = Math.round(tg * f);
    px[i + 2] = Math.round(tb * f);
  }
  g.putImageData(im, 0, 0);
  return cv;
}

// The composite is laid out in the engine's own base px (`tankDrawGeometry`, Player Size 1) and
// zoomed ×S for a crisp bitmap. `PAD` is slack for the barrel's own half-thickness, `FLOOR` the
// strip of blank below the ground line. Hard-coding these proportions instead is what floated the
// Atomic Cannon's barrel: it has the longest barrel (61px of art) on the shortest hull, so both a
// fixed length and a fixed pivot height were wrong for it.
const PV = {S: 3, PAD: 4, FLOOR: 2};

/** Where the barrel rests until the pointer has moved: 45° up-right, the angle a tank spawns at. */
const REST_AIM = Math.PI / 4;

/**
 * One frame shared by EVERY hull, so the models stay the same size as you page through the picker
 * (a per-model canvas would be fitted to the CSS box at a different zoom each time) and none of
 * them clips. Sized for the worst case of the roster's longest barrel at the extremes of its sweep:
 * full `barrelLen` sideways at 0°/180°, `pivotUp + barrelLen` tall at 90°.
 */
const FRAME = ((): {w: number; h: number} => {
  let halfW = 0,
    top = 0;
  for (const model of PLAYER_TANKS) {
    const {hullW, barrelLen, pivotUp} = tankDrawGeometry(model);
    halfW = Math.max(halfW, hullW / 2, barrelLen);
    top = Math.max(top, pivotUp + barrelLen);
  }
  return {
    w: Math.ceil((halfW + PV.PAD) * 2 * PV.S),
    h: Math.ceil((top + PV.PAD + PV.FLOOR) * PV.S),
  };
})();

/** A hull's recoloured parts, ready to composite at any aim. */
interface TankArt {
  body: HTMLCanvasElement;
  turret: HTMLCanvasElement;
}

// Recolouring is two image loads plus a per-pixel pass, so it must NOT happen per pointer move —
// only per (hull, colour). Capped like the engine's own sprite caches, since dragging across the
// palette bar mints an arbitrary number of colours. In-flight promises are cached too, so a fast
// drag doesn't start the same work twice.
const artCache = new Map<string, Promise<TankArt>>();
const ART_CACHE_MAX = 64;

/** The recoloured hull + turret for `model` in `hex`, loaded once and reused. */
function loadTankArt(model: string, hex: string): Promise<TankArt> {
  const key = `${model}|${hex}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const pending = Promise.all([
    recolorToCanvas(`/assets/tanks/${model} body.bmp`, hex),
    recolorToCanvas(`/assets/tanks/${model} turret.bmp`, hex),
  ]).then(([body, turret]) => ({body, turret}));
  // A failed load must not be remembered as the answer forever — drop it and let a retry happen.
  pending.catch(() => artCache.delete(key));
  capSet(artCache, key, pending, ART_CACHE_MAX);
  return pending;
}

/** The turret pivot in frame coordinates — the point the barrel swings around. */
function pivotOf(model: string): {x: number; y: number} {
  const {pivotUp} = tankDrawGeometry(model);
  return {x: FRAME.w / 2, y: FRAME.h - (PV.FLOOR + pivotUp) * PV.S};
}

/**
 * The aim (radians CCW from right, as `CTank` stores it) that points `model`'s barrel at the
 * viewport point (`clientX`, `clientY`), given where its `canvas` currently sits on screen.
 *
 * Clamped to the upward half-circle — the same 0..180° the battlefield opens on, "since a tank
 * would open the battle pointing into dirt". Below the horizon the barrel parks flat on whichever
 * side the pointer is, rather than folding to the wrong one.
 */
function aimToward(canvas: HTMLCanvasElement, model: string, clientX: number, clientY: number): number {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return REST_AIM;
  const pivot = pivotOf(model);
  // The canvas is drawn at frame resolution but displayed scaled to fit its box.
  const dx = ((clientX - r.left) / r.width) * FRAME.w - pivot.x;
  const dy = ((clientY - r.top) / r.height) * FRAME.h - pivot.y;
  const aim = Math.atan2(-dy, dx); // screen-Y is down, engine angles are Y-up
  if (aim >= 0) return aim;
  return dx < 0 ? Math.PI : 0; // below the horizon → flat on the pointer's own side
}

/**
 * Paint `model`'s recoloured hull + turret at `aim`, laid out as the field render does it: hull
 * bottom on the ground line, barrel from the hull-top pivot via the engine's own `drawTurretSprite`.
 */
function paint(g: CanvasRenderingContext2D, art: TankArt, model: string, aim: number): void {
  const {S} = PV;
  const {hullW, barrelLen} = tankDrawGeometry(model);
  const bw = hullW * S;
  const bh = (art.body.height / art.body.width) * bw;
  // Barrel length comes from the turret art itself (as on the field), so its thickness follows
  // from the bitmap's own aspect.
  const tl = barrelLen * S;
  const tt = (art.turret.height / art.turret.width) * tl;

  g.clearRect(0, 0, FRAME.w, FRAME.h);
  g.imageSmoothingEnabled = false;
  const groundY = FRAME.h - PV.FLOOR * S;
  // Turret first so the hull overlaps its root; then the hull on top.
  drawTurretSprite(g, art.turret, pivotOf(model), aim, tl, tt);
  g.drawImage(art.body, FRAME.w / 2 - bw / 2, groundY - bh, bw, bh);
}

/** A running preview: swap what it shows, or shut it down. */
export interface TankPreviewHandle {
  /** Show a different hull and/or colour. The barrel KEEPS its current aim. */
  show(model: string, hex: string): void;
  dispose(): void;
}

/**
 * Start the live hull preview on `canvas`: size it, and track the pointer with the barrel — a
 * gimmick, the aim it ends on means nothing to the match.
 *
 * Only pointer movement inside `region` aims the turret (the player card, so the tank watches you
 * work its own panel and ignores the rest of the screen). Leaving the region doesn't recentre it:
 * it simply holds the last aim until you come back.
 *
 * The aim lives in this closure, NOT in the arguments, so paging to another tank or dragging a new
 * colour goes through `show()` and leaves the barrel where you put it. Rebuilding the preview per
 * hull instead made it snap back to rest on every change and then jump to the pointer.
 *
 * The whole thing lives here rather than in the component so the editor stays declarative: a
 * pointer move only re-composites two cached bitmaps on an animation frame, never a Preact render
 * and never a recolour.
 */
export function runTankPreview(canvas: HTMLCanvasElement, region: HTMLElement): TankPreviewHandle {
  canvas.width = FRAME.w;
  canvas.height = FRAME.h;
  const g = canvas.getContext('2d');
  if (!g) return {show: () => {}, dispose: () => {}};

  let art: TankArt | null = null;
  let model = ''; // the hull currently DRAWN — set with its art, so the two never disagree
  let aim = REST_AIM;
  let frame = 0;
  let generation = 0; // bumped per show()/dispose(), so a slow recolour can't land after a newer one

  const redraw = () => {
    frame = 0;
    if (art) paint(g, art, model, aim);
  };
  const onMove = (e: PointerEvent) => {
    aim = aimToward(canvas, model, e.clientX, e.clientY);
    frame ||= requestAnimationFrame(redraw);
  };
  // On the region, not the window: the events from its children bubble up here anyway (including
  // during a colour drag, which captures the pointer to the palette bar but still bubbles).
  region.addEventListener('pointermove', onMove);

  return {
    show(nextModel: string, hex: string): void {
      const mine = ++generation;
      void loadTankArt(nextModel, hex).then(loaded => {
        if (mine !== generation) return; // a newer hull/colour won while we were recolouring
        art = loaded;
        model = nextModel;
        redraw(); // the previous hull stays up until this lands, so there's no blank frame
      });
    },
    dispose(): void {
      generation++; // orphan any in-flight recolour
      region.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
