/**
 * CAssetManager - sprite/texture loading.
 *
 * Loads images from the served asset tree and resolves logical names to
 * drawable sprites. Paletted hull sprites use a magenta (255,0,255) colorkey
 * for transparency, which is knocked out to alpha at load time.
 */

import type { Sprite, ISpriteSource } from '../CTank';

type RGB = [number, number, number];

const MAGENTA: RGB = [255, 0, 255];
const KEY_TOLERANCE = 24;

export class CAssetManager implements ISpriteSource {

  private m_sprites: Map<string, Sprite> = new Map();
  private m_pending: number = 0;

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
  async loadImage(name: string, path: string): Promise<void> {
    this.m_pending++;
    const img = await this.fetchImage(path);
    if (img) {
      this.m_sprites.set(name, { bitmap: img, width: img.width, height: img.height });
    }
    this.m_pending--;
  }

  /**
   * Load a sprite and knock out a colorkey (magenta by default) to
   * transparency, producing a canvas-backed sprite with real alpha.
   */
  async loadSprite(name: string, path: string, colorKey: RGB = MAGENTA): Promise<void> {
    this.m_pending++;
    const img = await this.fetchImage(path);
    if (img) {
      const canvas = this.applyColorKey(img, colorKey);
      this.m_sprites.set(name, { bitmap: canvas, width: canvas.width, height: canvas.height });
    }
    this.m_pending--;
  }

  private fetchImage(path: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { console.warn(`asset load failed: ${path}`); resolve(null); };
      // Filenames contain spaces — encode for a valid URL.
      img.src = encodeURI(path);
    });
  }

  /** Draw the image to an offscreen canvas and zero the alpha of key pixels. */
  private applyColorKey(img: HTMLImageElement, [kr, kg, kb]: RGB): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;

    const g = canvas.getContext('2d')!;
    g.drawImage(img, 0, 0);

    const image = g.getImageData(0, 0, canvas.width, canvas.height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - kr) <= KEY_TOLERANCE &&
          Math.abs(px[i + 1] - kg) <= KEY_TOLERANCE &&
          Math.abs(px[i + 2] - kb) <= KEY_TOLERANCE) {
        px[i + 3] = 0;
      }
    }
    g.putImageData(image, 0, 0);
    return canvas;
  }
}
