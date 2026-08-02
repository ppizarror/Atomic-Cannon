/**
 * Minimal headless DOM mocks so CGameController / CLand / CAssetManager can be
 * constructed in node (tsx) for logic tests — no real canvas or image loading.
 */
type AnyFn = (...a: unknown[]) => unknown;
const noop: AnyFn = () => undefined;

function mockCtx(canvas?: MockCanvas): unknown {
  // Any method call is a no-op; property reads/writes are tolerated — EXCEPT the
  // ImageData pair, which is real. Draw code that composes a layer pixel by pixel
  // (CLand's radiation glow) writes it through createImageData/putImageData, so a
  // no-op there means the whole path is unexercised in tests and bugs in it are
  // invisible to the suite. Capturing the image lets a test assert what was painted.
  const target: Record<string, unknown> = {
    canvas: canvas ?? {width: 900, height: 600},
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (img: MockImage) => {
      if (canvas) canvas.lastImage = img;
    },
    // Returns an object rather than undefined: callers immediately call `addColorStop` on it, so
    // the bare no-op proxy throws the moment any gradient path is exercised.
    createLinearGradient: () => ({addColorStop: noop}),
    createRadialGradient: () => ({addColorStop: noop}),
    createPattern: () => null,
  };
  return new Proxy(target, {
    get: (t, k: string) => (k in t ? t[k] : noop),
    set: (t, k: string, v) => {
      t[k] = v;
      return true;
    },
  });
}

/** The last image `putImageData` wrote — how a test reads back a composed layer. */
export interface MockImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

class MockCanvas {
  width = 900;
  height = 600;
  lastImage: MockImage | null = null;

  getContext(): unknown {
    return mockCtx(this);
  }
}

export function installDomMocks(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.document) g.document = {createElement: (_t: string) => new MockCanvas()};
  if (!g.Image) {
    g.Image = class {
      onload: AnyFn | null = null;
      onerror: AnyFn | null = null;
      width = 1;
      height = 1;

      set src(_v: string) {
        /* never fires onload → sprites stay unloaded */
      }
    };
  }
  if (!g.HTMLCanvasElement) g.HTMLCanvasElement = MockCanvas;
}

export function makeCanvas(w = 900, h = 600): HTMLCanvasElement {
  const c = new MockCanvas();
  c.width = w;
  c.height = h;
  return c as unknown as HTMLCanvasElement;
}
