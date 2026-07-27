/**
 * The on-screen pixel RECT of the game scene (`#game-container`) — the surface the
 * engine's scene-fraction coordinates map onto. The offscreen buffer is CSS-stretched
 * to this element, so `x + fraction × w` gives the correct viewport pixel at any window
 * size. `x`/`y` are the container's viewport offset — nonzero when the game is inset for
 * the notch (Avoid-Notch), so overlays follow it instead of sitting at the screen edge.
 * Tracked with a ResizeObserver (size) + a resize/orientation listener (offset).
 */
import {useLayoutEffect, useState} from 'preact/hooks';

export function useSceneSize(): {x: number; y: number; w: number; h: number} {
  const [rect, setRect] = useState({x: 0, y: 0, w: 0, h: 0});
  useLayoutEffect(() => {
    const el = document.getElementById('game-container');
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({x: r.left, y: r.top, w: r.width, h: r.height});
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The inset (left/top offset) can change without a size change — e.g. rotating so the
    // notch flips side — so also re-measure on resize / orientation change.
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);
  return rect;
}
