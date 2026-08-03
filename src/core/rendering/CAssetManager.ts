/**
 * CAssetManager - sprite/texture loading.
 *
 * Loads images from the served asset tree and resolves logical names to
 * drawable sprites. Paletted hull sprites use a magenta (255,0,255) colorkey
 * for transparency, which is knocked out to alpha at load time.
 */

import type {Sprite, ISpriteSource} from './sprites';
import {knockoutWhere, makeCanvas2d, nearColor} from '../../util/canvas';

type RGB = [number, number, number];

const MAGENTA: RGB = [255, 0, 255];

export class CAssetManager implements ISpriteSource {
  private m_sprites: Map<string, Sprite> = new Map();
  private m_pending: number = 0;
  // In-flight loads by logical name. Every load is deduped through this: a second request for a
  // name that is already loaded (or still decoding) joins the first instead of re-fetching and
  // re-running the colour-key pass. Mid-battle callers rely on it — deploySentry asks for the
  // Sentry hull on EVERY turret it drops, which without this decoded the same three bitmaps again
  // each time. Cleared per entry once settled; the sprite map is the permanent cache.
  private m_loading: Map<string, Promise<void>> = new Map();
  // Names whose file could not be loaded. fetchImage resolves null rather than rejecting, so
  // without this a missing asset would be re-requested by every repeat caller (and warn each time).
  private m_failed: Set<string> = new Set();

  /** Resolve a logical sprite name (null if not loaded yet). */
  getSprite(name: string): Sprite | null {
    return this.m_sprites.get(name) ?? null;
  }

  /** True once every requested asset has finished loading (or failed). */
  isReady(): boolean {
    return this.m_pending === 0;
  }

  /**
   * Load a plain image as-is (no transparency processing). Suitable for
   * backgrounds and terrain textures.
   */
  loadImage(name: string, path: string): Promise<void> {
    return this.once(name, async () => {
      const img = await this.fetchImage(path);
      if (img) {
        this.m_sprites.set(name, {bitmap: img, width: img.width, height: img.height});
      }
    });
  }

  /**
   * Load a sprite and knock out a colorkey (magenta by default) to
   * transparency, producing a canvas-backed sprite with real alpha.
   */
  loadSprite(name: string, path: string, colorKey: RGB = MAGENTA): Promise<void> {
    return this.once(name, async () => {
      const img = await this.fetchImage(path);
      if (img) {
        const canvas = this.applyColorKey(img, colorKey);
        this.m_sprites.set(name, {bitmap: canvas, width: canvas.width, height: canvas.height});
      }
    });
  }

  /** Run `load` for `name` at most once: already-decoded names resolve immediately, concurrent
   *  requests share the first load's promise, and a name that failed is not retried (see
   *  m_failed). `m_pending` — what isReady/the loading screen watch — is only counted for the load
   *  that actually runs, so a duplicate request can never leave the counter above zero. */
  private once(name: string, load: () => Promise<void>): Promise<void> {
    const inflight = this.m_loading.get(name);
    if (inflight) return inflight;
    if (this.m_sprites.has(name) || this.m_failed.has(name)) return Promise.resolve();
    this.m_pending++;
    const p = load().finally(() => {
      if (!this.m_sprites.has(name)) this.m_failed.add(name); // fetchImage warned; don't ask again
      this.m_pending--;
      this.m_loading.delete(name);
    });
    this.m_loading.set(name, p);
    return p;
  }

  private fetchImage(path: string): Promise<HTMLImageElement | null> {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.warn(`asset load failed: ${path}`);
        resolve(null);
      };
      // Filenames contain spaces — encode for a valid URL.
      img.src = encodeURI(path);
    });
  }

  /** Draw the image to an offscreen canvas and zero the alpha of key pixels. */
  private applyColorKey(img: HTMLImageElement, key: RGB): HTMLCanvasElement {
    const {cv: canvas, ctx: g} = makeCanvas2d(img.width, img.height);
    g.drawImage(img, 0, 0);

    const image = g.getImageData(0, 0, canvas.width, canvas.height);
    knockoutWhere(image.data, nearColor(key[0], key[1], key[2])); // key colour -> transparent
    g.putImageData(image, 0, 0);
    return canvas;
  }
}
