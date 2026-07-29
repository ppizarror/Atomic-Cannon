/**
 * CAssetManager loads each logical name at most once. This matters mid-battle: deploySentry asks
 * for the Sentry hull on every turret it drops, and each of those calls used to re-fetch and re-run
 * the colour-key pass over the same three bitmaps.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {CAssetManager} from '../src/core/rendering/CAssetManager';

// Count Image constructions — one per real network fetch.
let built: string[] = [];
const realImage = globalThis.Image;
const realDoc = globalThis.document;

beforeEach(() => {
  built = [];
  class CountingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 8;
    height = 8;
    set src(v: string) {
      built.push(v);
      // Resolve asynchronously, like a real decode, so concurrent callers overlap.
      setTimeout(() => (v.includes('missing') ? this.onerror?.() : this.onload?.()), 0);
    }
  }
  (globalThis as {Image: unknown}).Image = CountingImage;
  // The shared _dom mock's 2D context returns undefined for getImageData, which the colour-key
  // pass dereferences. Stub just enough of it here rather than widening the shared mock (other
  // tests rely on its sprites never loading).
  (globalThis as {document: unknown}).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        putImageData: () => undefined,
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
          width: w,
          height: h,
        }),
      }),
    }),
  };
});
afterEach(() => {
  (globalThis as {Image: unknown}).Image = realImage;
  (globalThis as {document: unknown}).document = realDoc;
});

describe('CAssetManager load dedupe', () => {
  it('fetches once for repeat sequential loads of the same name', async () => {
    const a = new CAssetManager();
    await a.loadSprite('tanks/Sentry body', '/assets/tanks/Sentry body.bmp');
    expect(built).toHaveLength(1);
    expect(a.getSprite('tanks/Sentry body')).not.toBeNull();

    // Eight turrets deployed → eight more requests for an already-decoded name, no extra work.
    await Promise.all(
      Array.from({length: 8}, () =>
        a.loadSprite('tanks/Sentry body', '/assets/tanks/Sentry body.bmp'),
      ),
    );
    expect(built).toHaveLength(1);
  });

  it('concurrent loads of one name share a single fetch', async () => {
    const a = new CAssetManager();
    await Promise.all(
      Array.from({length: 5}, () => a.loadSprite('gui/crate', '/assets/gui/crate.bmp')),
    );
    expect(built).toHaveLength(1);
    expect(a.getSprite('gui/crate')).not.toBeNull();
  });

  it('leaves isReady() settled after duplicate requests', async () => {
    // The loading screen watches isReady(); a deduped call must not leave the counter raised.
    const a = new CAssetManager();
    const loads = [
      a.loadSprite('x', '/assets/gui/crate.bmp'),
      a.loadSprite('x', '/assets/gui/crate.bmp'),
      a.loadImage('y', '/assets/gui/jet.bmp'),
    ];
    expect(a.isReady()).toBe(false); // work in flight
    await Promise.all(loads);
    expect(a.isReady()).toBe(true);
  });

  it('does not re-request a name whose file is missing', async () => {
    const a = new CAssetManager();
    await a.loadSprite('gone', '/assets/missing.bmp');
    await a.loadSprite('gone', '/assets/missing.bmp');
    await a.loadSprite('gone', '/assets/missing.bmp');
    expect(built).toHaveLength(1); // warned once, then left alone
    expect(a.getSprite('gone')).toBeNull();
    expect(a.isReady()).toBe(true);
  });

  it('still loads distinct names independently', async () => {
    const a = new CAssetManager();
    await Promise.all([
      a.loadSprite('tanks/Sentry body', '/assets/tanks/Sentry body.bmp'),
      a.loadSprite('tanks/Sentry turret', '/assets/tanks/Sentry turret.bmp'),
      a.loadSprite('tanks/Sentry wreck', '/assets/tanks/Sentry wreck.bmp'),
    ]);
    expect(built).toHaveLength(3);
    for (const p of ['body', 'turret', 'wreck']) {
      expect(a.getSprite(`tanks/Sentry ${p}`)).not.toBeNull();
    }
  });
});
