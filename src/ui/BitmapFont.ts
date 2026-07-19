/**
 * Bitmap fonts — the game's fonts (`assets/fonts/*.bmp`) are horizontal glyph
 * strips for ASCII 33..126 on a CYAN (0,255,255) background, with MAGENTA
 * (255,0,255) markers in row 0 at each glyph's left edge (encodes the widths).
 * This reads those markers to slice glyphs, then colorkeys cyan+magenta away.
 */

const isMagenta = (px: Uint8ClampedArray, i: number) =>
  px[i] > 170 && px[i + 1] < 90 && px[i + 2] > 170;
const isCyan = (px: Uint8ClampedArray, i: number) =>
  px[i] < 90 && px[i + 1] > 170 && px[i + 2] > 170;

const FIRST = 33; // '!'  — the strip starts here; space (32) is advance-only.

export class BitmapFont {
  ready = false;
  height = 0;
  private cv: HTMLCanvasElement | null = null;
  private glyphs: { x: number; w: number }[] = [];   // index 0 == ASCII 33
  private waiters: (() => void)[] = [];
  private tinted = new Map<string, HTMLCanvasElement>();

  constructor(path: string) {
    const img = new Image();
    img.onload = () => this.parse(img);
    img.onerror = () => { this.ready = true; this.flush(); };
    img.src = encodeURI(path);
  }

  onReady(cb: () => void): void { if (this.ready) cb(); else this.waiters.push(cb); }
  private flush(): void { this.waiters.splice(0).forEach(f => f()); }

  private parse(img: HTMLImageElement): void {
    const src = document.createElement('canvas');
    src.width = img.width; src.height = img.height;
    const sg = src.getContext('2d', { willReadFrequently: true })!;
    sg.drawImage(img, 0, 0);
    const W = img.width, H = img.height;
    const px = sg.getImageData(0, 0, W, H).data;

    // Row 0 holds a magenta marker at each glyph's left edge.
    const marks: number[] = [];
    for (let x = 0; x < W; x++) if (isMagenta(px, x * 4)) marks.push(x);
    for (let k = 0; k < marks.length; k++) {
      const x0 = marks[k] + 1;
      const x1 = k + 1 < marks.length ? marks[k + 1] : W;
      if (x1 > x0) this.glyphs.push({ x: x0, w: x1 - x0 });
    }

    // Build the glyph atlas from rows 1..H-1 (drop the marker row), with the
    // cyan background and any stray magenta keyed out to transparent.
    const gh = H - 1;
    const atlas = document.createElement('canvas');
    atlas.width = W; atlas.height = gh;
    const ag = atlas.getContext('2d', { willReadFrequently: true })!;
    ag.drawImage(src, 0, 1, W, gh, 0, 0, W, gh);
    const aim = ag.getImageData(0, 0, W, gh);
    const apx = aim.data;
    for (let i = 0; i < apx.length; i += 4) if (isCyan(apx, i) || isMagenta(apx, i)) apx[i + 3] = 0;
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
  private spaceW() { return Math.max(3, Math.round(this.height * 0.3)); }

  measure(text: string, spacing = 1): number {
    let w = 0;
    for (const c of text) w += (c === ' ' ? this.spaceW() : (this.glyph(c.charCodeAt(0))?.w ?? this.spaceW())) + spacing;
    // `spacing` sits BETWEEN glyphs, not after the last — otherwise a negative
    // spacing under-sizes the canvas and clips the final glyph.
    return Math.max(1, w - spacing);
  }

  /** The (cached) glyph atlas, optionally recoloured to `tint` (keeps alpha). */
  private atlas(tint?: string): HTMLCanvasElement | null {
    if (!this.cv) return null;
    if (!tint) return this.cv;
    let t = this.tinted.get(tint);
    if (!t) {
      t = document.createElement('canvas');
      t.width = this.cv.width; t.height = this.cv.height;
      const g = t.getContext('2d')!;
      g.drawImage(this.cv, 0, 0);
      g.globalCompositeOperation = 'source-in';   // recolour opaque pixels
      g.fillStyle = tint;
      g.fillRect(0, 0, t.width, t.height);
      this.tinted.set(tint, t);
    }
    return t;
  }

  /** Render text to a fresh canvas at native pixel size (transparent bg). */
  render(text: string, opts: { spacing?: number; tint?: string } = {}): HTMLCanvasElement {
    const spacing = opts.spacing ?? 1;
    const out = document.createElement('canvas');
    out.width = this.measure(text, spacing);
    out.height = this.height || 1;
    const src = this.atlas(opts.tint);
    if (!this.ready || !src) return out;
    const g = out.getContext('2d')!;
    let cx = 0;
    for (const c of text) {
      if (c === ' ') { cx += this.spaceW() + spacing; continue; }
      const gl = this.glyph(c.charCodeAt(0));
      if (gl) { g.drawImage(src, gl.x, 0, gl.w, this.height, cx, 0, gl.w, this.height); cx += gl.w + spacing; }
      else cx += this.spaceW() + spacing;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Font catalog. Short, memorable ids → the real `.bmp` filename under
// public/assets/fonts. Everything that draws bitmap text (`<BmpText>`, the tank
// badge labels) takes a `FontId`, so only fonts that actually exist can be
// referenced: a typo is a compile error, never a silent blank render. Add a new
// font by dropping its `.bmp` in the fonts folder and adding one line here.
export const FONTS = {
  'arial-14':           'Arial 14',
  'arial-14-out':       'Arial 14 outlined',
  'arial-black-16-out': 'Arial Black 16 outlined',
  'bazouk-28':          'BazoukSSK 28 bold outlined',
  'beijing-16':         'BeijingSSK 16',
  'beijing-16-out':     'BeijingSSK 16 outlined',
  'beijing-20':         'BeijingSSK 20',
  'beijing-20-out':     'BeijingSSK 20 outlined',
  'msans-12':           'Microsoft Sans Serif 12',
  'msans-14':           'Microsoft Sans Serif 14',
  'msans-18':           'Microsoft Sans Serif 18',
  'trebuchet-9':        'Trebuchet MS 9 bold',
  'trebuchet-18':       'Trebuchet MS 18',
  'silkscreen-8':       'UPF Silkscreen ReMix 8',
  'silkscreen-8-black': 'UPF Silkscreen ReMix 8 black',
  'silkscreen-8-out':   'UPF Silkscreen ReMix 8 outlined',
  'silkscreen-8-white': 'UPF Silkscreen ReMix 8 white',
  'verdana-10-out':     'Verdana 10 bold outlined',
  'fire':               'fire',
} as const;

/** The only strings any caller may pass as a font — the keys of FONTS. */
export type FontId = keyof typeof FONTS;

const registry = new Map<FontId, BitmapFont>();
export function getFont(id: FontId): BitmapFont {
  let f = registry.get(id);
  if (!f) { f = new BitmapFont(`/assets/fonts/${FONTS[id]}.bmp`); registry.set(id, f); }
  return f;
}
