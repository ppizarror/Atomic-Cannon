/**
 * Minimal headless DOM mocks so CGameController / CLand / CAssetManager can be
 * constructed in node (tsx) for logic tests — no real canvas or image loading.
 */
type AnyFn = (...a: unknown[]) => unknown;
const noop: AnyFn = () => undefined;

function mockCtx(): unknown {
    // Any method call is a no-op; property reads/writes are tolerated. Draw code
    // is never exercised by these tests, so exact behaviour doesn't matter.
    const target: Record<string, unknown> = {canvas: {width: 900, height: 600}};
    return new Proxy(target, {
        get: (t, k: string) => (k in t ? t[k] : noop),
        set: (t, k: string, v) => {
            t[k] = v;
            return true;
        },
    });
}

class MockCanvas {
    width = 900;
    height = 600;

    getContext(): unknown {
        return mockCtx();
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

            set src(_v: string) { /* never fires onload → sprites stay unloaded */
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
