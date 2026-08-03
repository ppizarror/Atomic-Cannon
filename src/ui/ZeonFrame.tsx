/**
 * The `zeon` UI dialog frame — the real assets/gui/zeon/dialog.bmp drawn as a
 * crisp 9-slice behind its parent's content. dialog.bmp is a 33×33 beveled
 * rounded box: pure #00ff00 fill, a light-green highlight bevel on the top/left,
 * a dark-green shadow bevel on the bottom/right, and black diagonal-rounded
 * corners (its outer grey keyed transparent). border-image mangles those
 * diagonal corners, so we blit the nine slices to a <canvas> at native pixel
 * scale instead — corners 1:1, edges + centre stretched.
 *
 * Drop it as the FIRST child of a positioned box (position: relative/fixed) and
 * give the real content a higher stacking level; the frame fills the box
 * (inset: 0) and redraws whenever the box resizes. Shared by the depot tooltip
 * and any other zeon dialog.
 */
import {useLayoutEffect, useRef} from 'preact/hooks';
import {loadUiBmp} from './store';

const SRC = 33; // dialog.bmp is 33×33
const C = 11; // corner slice (33 = 11+11+11) — captures the rounded corner + bevel

// Load + colour-key the frame bitmap once, shared across every ZeonFrame instance.
let framePromise: Promise<HTMLImageElement | null> | null = null;

function frameImage(): Promise<HTMLImageElement | null> {
  if (!framePromise) {
    framePromise = loadUiBmp('gui/zeon/dialog.bmp', 'greyblack').then(url =>
      url
        ? new Promise<HTMLImageElement | null>(res => {
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = () => res(null);
            img.src = url;
          })
        : null,
    );
  }
  return framePromise;
}

/** Warm the shared frame bitmap (fetch + colour-key + decode) ahead of first use, so the depot
 *  tooltip's green box is drawn the instant it opens instead of popping in a frame late. Idempotent
 *  (the promise is cached). */
export function preloadZeonFrame(): Promise<unknown> {
  return frameImage();
}

export function ZeonFrame() {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const cv = ref.current;
    const parent = cv?.parentElement;
    if (!cv || !parent) return;

    let img: HTMLImageElement | null = null;
    const draw = () => {
      if (!img) return;
      const w = Math.max(2 * C, Math.ceil(parent.clientWidth));
      const h = Math.max(2 * C, Math.ceil(parent.clientHeight));
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      const g = cv.getContext('2d')!;
      g.imageSmoothingEnabled = false; // crisp pixel scaling
      g.clearRect(0, 0, w, h);
      const m = SRC - 2 * C; // source middle strip (11px)
      const dw = w - 2 * C,
        dh = h - 2 * C; // dest middle spans
      const blit = (
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dxw: number,
        dxh: number,
      ) => {
        if (sw > 0 && sh > 0 && dxw > 0 && dxh > 0) g.drawImage(img!, sx, sy, sw, sh, dx, dy, dxw, dxh);
      };
      // 4 corners (1:1, never scaled)
      blit(0, 0, C, C, 0, 0, C, C);
      blit(SRC - C, 0, C, C, w - C, 0, C, C);
      blit(0, SRC - C, C, C, 0, h - C, C, C);
      blit(SRC - C, SRC - C, C, C, w - C, h - C, C, C);
      // 4 edges (stretched along their run, native across)
      blit(C, 0, m, C, C, 0, dw, C); // top
      blit(C, SRC - C, m, C, C, h - C, dw, C); // bottom
      blit(0, C, C, m, 0, C, C, dh); // left
      blit(SRC - C, C, C, m, w - C, C, C, dh); // right
      // centre fill
      blit(C, C, m, m, C, C, dw, dh);
    };

    let ro: ResizeObserver | undefined;
    frameImage().then(i => {
      img = i;
      draw();
    });
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(draw);
      ro.observe(parent);
    }
    return () => ro?.disconnect();
  }, []);

  return <canvas ref={ref} class="zeon-frame" />;
}
