/**
 * The on-screen pixel size of the game scene (`#game-container`) — the surface the
 * engine's scene-fraction coordinates map onto. The offscreen buffer is CSS-stretched
 * to this element, so a fraction × this size gives the correct viewport pixel at any
 * window size. Tracked with a ResizeObserver so it stays right across resizes.
 */
import {useLayoutEffect, useState} from 'preact/hooks';

export function useSceneSize(): {w: number; h: number} {
  const [size, setSize] = useState({w: 0, h: 0});
  useLayoutEffect(() => {
    const el = document.getElementById('game-container');
    if (!el) return;
    const measure = () => setSize({w: el.clientWidth, h: el.clientHeight});
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return size;
}
