/**
 * Renders a string with a bitmap font. By default it draws at the font's NATIVE
 * pixel size (1:1) so glyphs stay crisp — these are 1-bit strips and fractional
 * downscaling turns them to mush. Pass `scale` for integer magnification, or
 * `height` only when you deliberately want CSS scaling.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { getFont } from './BitmapFont';

export function BmpText({ font, text, height, scale, tint, spacing, class: cls }: {
  font: string;
  text: string;
  height?: number;   // optional forced CSS height (may blur if < native)
  scale?: number;    // integer magnification of the native size (crisp)
  tint?: string;
  spacing?: number;
  class?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  // Layout effect (not useEffect): size + draw the canvas BEFORE the browser
  // paints. A <canvas> with no dimensions defaults to 300x150, so drawing after
  // paint would flash a big empty box on every (re)mount — very visible behind a
  // coloured background like the active battle-status line.
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const f = getFont(font);
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const src = f.render(text, { tint, spacing });
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d')!.drawImage(src, 0, 0);
      const k = height ? height / (src.height || 1) : (scale ?? 1);
      c.style.width = `${Math.round(src.width * k)}px`;
      c.style.height = `${Math.round(src.height * k)}px`;
    };
    if (f.ready) {
      draw();
    } else {
      // Collapse to nothing until the font loads — never the 300x150 default.
      cv.width = 0; cv.height = 0;
      cv.style.width = '0px'; cv.style.height = '0px';
      f.onReady(draw);
    }
  }, [font, text, height, scale, tint, spacing]);

  return <canvas ref={ref} class={cls} style={{ imageRendering: 'pixelated', display: 'block' }} />;
}
