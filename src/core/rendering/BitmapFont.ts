/**
 * Bitmap fonts — the game's fonts (`assets/fonts/*.bmp`) are horizontal glyph
 * strips for ASCII 33..126 on a CYAN (0,255,255) background, with MAGENTA
 * (255,0,255) markers in row 0 at each glyph's left edge (encodes the widths).
 * This reads those markers to slice glyphs, then colorkeys cyan+magenta away.
 */

import {knockoutWhere} from '../../util/canvas';

const isMagenta = (px: Uint8ClampedArray, i: number) =>
  px[i] > 170 && px[i + 1] < 90 && px[i + 2] > 170;
const isCyan = (px: Uint8ClampedArray, i: number) =>
  px[i] < 90 && px[i + 1] > 170 && px[i + 2] > 170;

const FIRST = 33; // '!'  — the strip starts here; space (32) is advance-only.

export class BitmapFont {
  ready = false;
  height = 0;
  private cv: HTMLCanvasElement | null = null;
  private glyphs: {x: number; w: number}[] = []; // index 0 == ASCII 33
  private waiters: (() => void)[] = [];
  private rendered = new Map<string, HTMLCanvasElement>();
  private bounds = new Map<string, {top: number; height: number}>();

  constructor(private spec: FontSpec) {
    const img = new Image();
    img.onload = () => this.parse(img);
    img.onerror = () => {
      // `.bmp` missing/broken → ready but with no atlas, so render() draws the catalog
      // HTML fallback instead of a blank canvas.
      this.ready = true;
      this.flush();
    };
    img.src = encodeURI(`/assets/fonts/${spec.file}.bmp`);
  }

  onReady(cb: () => void): void {
    if (this.ready) cb();
    else this.waiters.push(cb);
  }

  private flush(): void {
    this.waiters.splice(0).forEach(f => f());
  }

  private parse(img: HTMLImageElement): void {
    const src = document.createElement('canvas');
    src.width = img.width;
    src.height = img.height;
    const sg = src.getContext('2d', {willReadFrequently: true})!;
    sg.drawImage(img, 0, 0);
    const W = img.width,
      H = img.height;
    const px = sg.getImageData(0, 0, W, H).data;

    // Row 0 holds a magenta marker at each glyph's left edge.
    const marks: number[] = [];
    for (let x = 0; x < W; x++) if (isMagenta(px, x * 4)) marks.push(x);
    for (let k = 0; k < marks.length; k++) {
      const x0 = marks[k] + 1;
      const x1 = k + 1 < marks.length ? marks[k + 1] : W;
      if (x1 > x0) this.glyphs.push({x: x0, w: x1 - x0});
    }

    // Build the glyph atlas from rows 1..H-1 (drop the marker row), with the
    // cyan background and any stray magenta keyed out to transparent.
    const gh = H - 1;
    const atlas = document.createElement('canvas');
    atlas.width = W;
    atlas.height = gh;
    const ag = atlas.getContext('2d', {willReadFrequently: true})!;
    ag.drawImage(src, 0, 1, W, gh, 0, 0, W, gh);
    const aim = ag.getImageData(0, 0, W, gh);
    const apx = aim.data;
    knockoutWhere(apx, (p, i) => isCyan(p, i) || isMagenta(p, i));
    ag.putImageData(aim, 0, 0);

    this.cv = atlas;
    this.height = gh;
    this.ready = true;
    this.flush();
  }

  private glyph(code: number) {
    const i = code - FIRST;
    return i >= 0 && i < this.glyphs.length ? this.glyphs[i] : undefined;
  }

  private spaceW() {
    return Math.max(3, Math.round(this.height * 0.3));
  }

  measure(text: string, spacing = 1): number {
    let w = 0;
    for (const c of text)
      w +=
        (c === ' ' ? this.spaceW() : (this.glyph(c.charCodeAt(0))?.w ?? this.spaceW())) + spacing;
    // `spacing` sits BETWEEN glyphs, not after the last — otherwise a negative
    // spacing under-sizes the canvas and clips the final glyph.
    return Math.max(1, w - spacing);
  }

  /** Render text to a fresh canvas at native pixel size (transparent bg).
   *  Colour comes from the font's baked .bmp — the fallback draws in the font's own
   *  colour (spec.tint), defaulting to white — so text is never recoloured at runtime. */
  private renderFallback(text: string): HTMLCanvasElement {
    const {family, size, weight} = this.spec;
    const font = `${weight ? `${weight} ` : ''}${size}px ${family}`;
    const out = document.createElement('canvas');
    const g = out.getContext('2d')!;
    g.font = font;
    out.width = Math.max(1, Math.ceil(g.measureText(text).width));
    out.height = Math.max(1, Math.ceil(size * 1.3)); // room for ascenders/descenders
    g.font = font; // resizing the canvas above reset the context state
    g.fillStyle = this.spec.tint ?? '#fff';
    g.textBaseline = 'middle';
    g.fillText(text, 0, out.height / 2);
    return out;
  }

  render(text: string, opts: {spacing?: number} = {}): HTMLCanvasElement {
    const spacing = opts.spacing ?? 1;
    const src = this.cv; // the glyph atlas, drawn in its own baked colour (no recolour)
    // No atlas yet (still loading, or the `.bmp` failed) → the catalog HTML fallback,
    // so callers always get a real sized canvas and never invent their own font.
    if (!this.ready || !src) return this.renderFallback(text);
    const out = document.createElement('canvas');
    out.width = this.measure(text, spacing);
    out.height = this.height || 1;
    const g = out.getContext('2d')!;
    let cx = 0;
    for (const c of text) {
      if (c === ' ') {
        cx += this.spaceW() + spacing;
        continue;
      }
      const gl = this.glyph(c.charCodeAt(0));
      if (gl) {
        g.drawImage(src, gl.x, 0, gl.w, this.height, cx, 0, gl.w, this.height);
        cx += gl.w + spacing;
      } else cx += this.spaceW() + spacing;
    }
    return out;
  }

  /**
   * `render()` memoised per (text, spacing) — the single rendered-text cache for
   * everything that draws bitmap text (the on-canvas tank badge, `<BmpText>`), so
   * callers no longer keep their own caches. Only stores the result once the font is
   * ready, so an early empty render never sticks. The returned canvas is shared —
   * blit FROM it, never draw INTO it.
   */
  renderCached(text: string, opts: {spacing?: number} = {}): HTMLCanvasElement {
    const key = `${opts.spacing ?? 1}|${text}`;
    const hit = this.rendered.get(key);
    if (hit) return hit;
    const cv = this.render(text, opts);
    if (this.ready) this.rendered.set(key, cv);
    return cv;
  }

  /**
   * Visible vertical extent of a rendered string — the topmost..bottommost rows that
   * actually have ink — as `{top, height}` in the label canvas. The font strips carry
   * blank rows above/below the glyphs, so callers that want TIGHT vertical
   * centring/padding (e.g. the tank name box) should pad around this, not the full
   * strip height. Independent of tint (alpha shape is the same), memoised per string.
   */
  contentBounds(text: string, spacing?: number): {top: number; height: number} {
    const key = `${spacing ?? 1}|${text}`;
    const hit = this.bounds.get(key);
    if (hit) return hit;
    const cv = this.renderCached(text, {spacing});
    let top = -1,
      bot = -1;
    if (this.ready && cv.width && cv.height) {
      const px = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
      for (let yy = 0; yy < cv.height; yy++) {
        let ink = false;
        for (let xx = 0; xx < cv.width; xx++)
          if (px[(yy * cv.width + xx) * 4 + 3] > 10) {
            ink = true;
            break;
          }
        if (ink) {
          if (top < 0) top = yy;
          bot = yy;
        }
      }
    }
    const res = top < 0 ? {top: 0, height: this.height || 1} : {top, height: bot - top + 1};
    if (this.ready) this.bounds.set(key, res);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Font catalog. Short, memorable ids → the real `.bmp` under public/assets/fonts
// PLUS the HTML font each one falls back to when its `.bmp` can't be loaded. The
// fallback is declared HERE, per font (a family that approximates the bitmap face and
// its px size), so no caller ever picks a fallback font — text is never blank and never
// an ad-hoc `sans-serif`. Everything that draws bitmap text takes a `FontId`, so only
// fonts that exist can be referenced (a typo is a compile error). Add a font by dropping
// its `.bmp` in the fonts folder and adding one line here.
export interface FontSpec {
  /** `.bmp` filename under public/assets/fonts (no extension). */
  file: string;
  /** CSS font-family the fallback draws with (approximates the bitmap face). */
  family: string;
  /** px size — the fallback's render size and line height. */
  size: number;
  /** Optional CSS weight for the fallback (e.g. `bold`, `900`). */
  weight?: string;
  /** The colour BAKED INTO the .bmp (its fill). The atlas already carries this, so it
   *  isn't applied at render time — it's the colour the HTML fallback draws with when
   *  the .bmp is missing, so a fallback matches the real font instead of always white.
   *  Defaults to white. Set it for non-white faces (e.g. the `-black` variants). */
  tint?: string;
}

export const FONTS = {
  'arial-14': {file: 'Arial 14', family: 'Arial, sans-serif', size: 14},
  'arial-14-out': {file: 'Arial 14 outlined', family: 'Arial, sans-serif', size: 14},
  'arial-black-16-out': {
    file: 'Arial Black 16 outlined',
    family: '"Arial Black", sans-serif',
    size: 16,
    weight: '900',
  },
  'bazouk-28': {
    file: 'BazoukSSK 28 bold outlined',
    family: 'Impact, sans-serif',
    size: 28,
    weight: 'bold',
  },
  'beijing-16': {file: 'BeijingSSK 16', family: '"Arial Narrow", sans-serif', size: 16},
  'beijing-16-out': {
    file: 'BeijingSSK 16 outlined',
    family: '"Arial Narrow", sans-serif',
    size: 16,
  },
  'beijing-20': {file: 'BeijingSSK 20', family: '"Arial Narrow", sans-serif', size: 20},
  'beijing-20-out': {
    file: 'BeijingSSK 20 outlined',
    family: '"Arial Narrow", sans-serif',
    size: 20,
  },
  'msans-12': {
    file: 'Microsoft Sans Serif 12',
    family: '"Microsoft Sans Serif", sans-serif',
    size: 12,
  },
  'msans-14': {
    file: 'Microsoft Sans Serif 14',
    family: '"Microsoft Sans Serif", sans-serif',
    size: 14,
  },
  'msans-18': {
    file: 'Microsoft Sans Serif 18',
    family: '"Microsoft Sans Serif", sans-serif',
    size: 18,
  },
  'trebuchet-9': {
    file: 'Trebuchet MS 9 bold',
    family: '"Trebuchet MS", sans-serif',
    size: 9,
    weight: 'bold',
  },
  'trebuchet-18': {file: 'Trebuchet MS 18', family: '"Trebuchet MS", sans-serif', size: 18},
  'silkscreen-8': {file: 'UPF Silkscreen ReMix 8', family: 'monospace', size: 8},
  'silkscreen-8-black': {
    file: 'UPF Silkscreen ReMix 8 black',
    family: 'monospace',
    size: 8,
    tint: '#000000',
  },
  'silkscreen-8-out': {file: 'UPF Silkscreen ReMix 8 outlined', family: 'monospace', size: 8},
  'silkscreen-8-white': {file: 'UPF Silkscreen ReMix 8 white', family: 'monospace', size: 8},
  'verdana-10-out': {
    file: 'Verdana 10 bold outlined',
    family: 'Verdana, sans-serif',
    size: 10,
    weight: 'bold',
  },
  fire: {file: 'fire', family: 'Impact, sans-serif', size: 22, weight: 'bold'},
} satisfies Record<string, FontSpec>;

/** The only strings any caller may pass as a font — the keys of FONTS. */
export type FontId = keyof typeof FONTS;
const registry = new Map<FontId, BitmapFont>();

export function getFont(id: FontId): BitmapFont {
  let f = registry.get(id);
  if (!f) {
    f = new BitmapFont(FONTS[id]);
    registry.set(id, f);
  }
  return f;
}
