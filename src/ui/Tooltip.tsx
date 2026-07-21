/**
 * The green "zeon" tooltip bubble — the real gui/dialog.bmp frame (9-sliced by
 * <ZeonFrame> into a beveled green box) with a down-pointer tail. One shape shared by
 * the Weapons Depot weapon tooltip and the in-game taunt bubble: both are a **title**
 * (weapon name / player name) over **content** (the description / the taunt line).
 *
 * The Tooltip owns its fonts and its line breaking — callers pass plain strings, never
 * pre-wrapped lines. Content is wrapped to a comfortable width here (bitmap-font text is
 * drawn one line per <BmpText>, so wrapping is line splitting).
 *
 * The frame + tail share ONE translucency group (`.tooltip-frame`, `opacity`) so they
 * composite opaquely and THEN fade together — otherwise the tail overlapping the box
 * doubles the alpha. The body rides above at full opacity. Drop it inside a positioned
 * wrapper (`.dep-tooltip` / `.taunt-bubble`) that places the bubble; the tail's
 * horizontal position is `tailLeft` (a CSS length, default centered).
 */
import {BmpText} from './BmpText';
import {ZeonFrame} from './ZeonFrame';

// Fonts the Tooltip controls (callers don't choose). The msans faces are baked BLACK,
// so they read as dark text on the bright-green frame with NO runtime tint — and a
// recolour would anti-alias the crisp bitmap into a blur, so we never tint here.
const TITLE_FONT = 'msans-14';
const CONTENT_FONT = 'msans-12';
const WRAP = 34; // characters per content line before splitting

// Greedy word-wrap into lines of ~`max` chars (honours any explicit newlines first).
function wrapLines(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > max) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line); // keep blank lines from explicit breaks
  }
  return out;
}

export function Tooltip({
  title,
  content,
  tailLeft = '50%',
  opacity = 0.82,
}: {
  title: string;
  content: string;
  /** Horizontal position of the tail's centre (any CSS length). */
  tailLeft?: string;
  /** Frame+tail group opacity (the body stays fully opaque). */
  opacity?: number;
}) {
  return (
    <div class="tooltip">
      <div class="tooltip-frame" style={{opacity}}>
        <ZeonFrame />
        <div class="tooltip-tail" style={{left: tailLeft}} />
      </div>
      <div class="tooltip-body">
        {title ? (
          <div class="tooltip-title">
            <BmpText font={TITLE_FONT} text={title} />
          </div>
        ) : null}
        <div class="tooltip-content">
          {wrapLines(content, WRAP).map((l, i) => (
            <BmpText key={i} font={CONTENT_FONT} text={l} />
          ))}
        </div>
      </div>
    </div>
  );
}
