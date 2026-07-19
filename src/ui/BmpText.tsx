/**
 * Renders a string with a bitmap font. By default it draws at the font's NATIVE
 * pixel size (1:1) so glyphs stay crisp — these are 1-bit strips and fractional
 * downscaling turns them to mush. Pass `scale` for integer magnification, or
 * `height` only when you deliberately want CSS scaling.
 */
import { useEffect, useRef } from 'preact/hooks';
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

  useEffect(() => {
    const f = getFont(font);
    const draw = () => {
      const cv = ref.current;
      if (!cv) return;
      const src = f.render(text, { tint, spacing });
      cv.width = src.width;
      cv.height = src.height;
      cv.getContext('2d')!.drawImage(src, 0, 0);
      const k = height ? height / (src.height || 1) : (scale ?? 1);
      cv.style.width = `${Math.round(src.width * k)}px`;
      cv.style.height = `${Math.round(src.height * k)}px`;
    };
    f.onReady(draw);
  }, [font, text, height, scale, tint, spacing]);

  return <canvas ref={ref} class={cls} style={{ imageRendering: 'pixelated', display: 'block' }} />;
}
