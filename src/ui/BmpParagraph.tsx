/**
 * A flowing block of bitmap text. Unlike <BmpText> (one strip, one line), this takes
 * a paragraph and wraps it to its own measured width, laying each wrapped line out as
 * a separate <BmpText>. The wrap is computed against the font's real glyph widths
 * (wrapText), so copy is authored with no line breaks and re-flows to the container —
 * and to whatever language / font it's drawn with.
 */
import {useLayoutEffect, useRef, useState} from 'preact/hooks';
import {BmpText, type FontId} from './BmpText';
import {getFont} from '../core/rendering/BitmapFont';
import {wrapWords} from '../core/rendering/wrapText';

export function BmpParagraph({
  font,
  text,
  spacing,
  class: cls,
}: {
  font: FontId;
  text: string;
  spacing?: number;
  class?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[]>([]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const f = getFont(font);
    const relayout = () => {
      const w = host.clientWidth;
      if (w <= 0) return;
      setLines(wrapWords(text, w, s => f.measure(s, spacing)));
    };
    relayout();
    // The font may still be loading — its measure switches from HTML-fallback metrics
    // to real glyph widths when the .bmp lands, so re-wrap once it's ready.
    if (!f.ready) f.onReady(relayout);
    // And re-wrap whenever the container width changes (resize / scrollbar reserve).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(relayout) : null;
    ro?.observe(host);
    return () => ro?.disconnect();
  }, [font, text, spacing]);

  return (
    <div ref={hostRef} class={cls}>
      {lines.map((ln, i) =>
        // A blank wrapped line is an intentional gap — give it height with a space.
        ln ? <BmpText key={i} font={font} text={ln} spacing={spacing} /> : <div key={i} class="bmp-para-gap" />,
      )}
    </div>
  );
}
