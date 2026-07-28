/**
 * The green "zeon" tooltip bubble — the real gui/dialog.bmp frame (9-sliced by
 * <ZeonFrame> into a beveled green box) with an arrow tail. One shape shared by the
 * Weapons Depot weapon tooltip and the in-game taunt bubble: both are a **title**
 * (weapon name / player name) over **content** (the description / the taunt line).
 *
 * The Tooltip owns its fonts and line breaking (callers pass plain strings), and — in
 * ANCHORED mode — its own on-screen placement: given the point its tail should aim at,
 * it positions itself, clamps to stay fully inside its bounds (the viewport by default,
 * a margin from the edges), and slides the tail so it keeps pointing at the target.
 * The tail wins over the clamp: once the target moves so far out that the box could no
 * longer point at it, the box travels WITH the target (off the edge, for the caller's
 * clip layer to crop) rather than sticking to the edge. Otherwise it's a plain box a
 * caller positions via a wrapper (the tail sits at `tailLeft`).
 *
 * The frame + tail share ONE translucency group (`.tooltip-frame`, `opacity`) so they
 * composite opaquely and THEN fade together; the body rides above at full opacity.
 */
import {useLayoutEffect, useRef, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {ZeonFrame} from './ZeonFrame';
import {loadUiBmp} from './store';
import {useAsyncImage} from './useAsyncImage';

// Fonts the Tooltip controls (callers don't choose). The msans faces are baked BLACK,
// so they read as dark text on the bright-green frame with NO runtime tint — a recolour
// would anti-alias the crisp bitmap into a blur, so we never tint here.
const TITLE_FONT = 'msans-14';
const CONTENT_FONT = 'msans-12';
const WRAP = 34; // characters per content line before splitting

// Edge-clamp geometry (anchored mode).
const MARGIN = 8; // keep the box this far from the view edge
const TAIL_HOME = 14; // the tail's resting x within the box (near the left)
const TAIL_MIN = 12; // keep the tail this far from the box's own edges

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// The tail arrow sprites (a matched set with the zeon dialog.bmp frame): a green fill
// on a grey background with a black bevel. Both the grey AND black are keyed out
// (`greyblack`) to match the frame. `down` points at an anchor below the bubble; `up` above.
type TipPosition = 'down' | 'up';

function TooltipTail({tip, tailLeft}: {tip: TipPosition; tailLeft: string}) {
  const src = useAsyncImage(() => loadUiBmp(`gui/zeon/tt arrow ${tip}.bmp`, 'greyblack'), [tip]);
  return (
    <span class={`tooltip-tail tip-${tip}`} style={{left: tailLeft}}>
      {src ? <img src={src} alt="" /> : null}
    </span>
  );
}

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
  tipPosition = 'down',
  opacity = 0.72,
  animated = false,
  anchorX,
  anchorY,
  anchorClass,
  bounds,
  fade = 1,
}: {
  title: string;
  content: string;
  /** Static mode: tail x within the box (any CSS length). Ignored in anchored mode. */
  tailLeft?: string;
  /** Which way the tail arrow points: `down` (anchor below, default) or `up`. */
  tipPosition?: TipPosition;
  /** Frame+tail group opacity (the body stays fully opaque). */
  opacity?: number;
  /** Grow-from-centre "pop" as it appears. Show-only — instant removal. */
  animated?: boolean;
  /** ANCHORED mode: the x/y the tail tip should aim at, in the coordinate space of the
   *  anchor's containing block (the viewport unless the caller supplies one). When set,
   *  the Tooltip positions AND edge-clamps itself; the tail slides to stay on the target. */
  anchorX?: number;
  anchorY?: number;
  /** Extra class on the anchored wrapper (e.g. to raise its z-index above the depot). */
  anchorClass?: string;
  /** The horizontal band the box is clamped into (same space as `anchorX`). Defaults to
   *  the viewport — pass the scene rect when the anchor is scene-relative. */
  bounds?: {left: number; right: number};
  /** Whole-bubble fade multiplier for anchored mode (e.g. a taunt dying out). */
  fade?: number;
}) {
  const anchored = anchorX != null && anchorY != null;

  // Measure the box width (layout width — unaffected by the pop scale) and re-measure
  // when its content resizes: the bitmap-font canvases size in asynchronously, so the
  // width grows after mount — a ResizeObserver keeps the clamp honest.
  const boxRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!anchored || !el) return;
    const measure = () => setW(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchored]);

  // Compute the clamped left + tail every render from the live anchor + measured width.
  let left = (anchorX ?? 0) - TAIL_HOME;
  let resolvedTail = tailLeft;
  if (anchored && w > 0) {
    const lo = (bounds?.left ?? 0) + MARGIN;
    const hi = (bounds?.right ?? window.innerWidth) - MARGIN - w;
    // The tail must stay inside the box, which pins `left` to a band around the anchor.
    // Applying it AFTER the edge-clamp is what makes the box follow a target that has
    // left the bounds (camera scrolling the speaker off) instead of parking at the edge.
    const tailLo = anchorX! - (w - TAIL_MIN);
    const tailHi = anchorX! - TAIL_MIN;
    left = clamp(clamp(anchorX! - TAIL_HOME, lo, hi), tailLo, tailHi);
    resolvedTail = `${clamp(anchorX! - left, TAIL_MIN, w - TAIL_MIN)}px`;
  }

  const box = (
    <div ref={boxRef} class={`tooltip${animated ? ' animated' : ''}`}>
      <div class="tooltip-frame" style={{opacity}}>
        <ZeonFrame />
        <TooltipTail tip={tipPosition} tailLeft={resolvedTail} />
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

  // Static mode: the caller's wrapper positions the box.
  if (!anchored) return box;

  // Anchored mode: the Tooltip places itself (fixed) so its tail tip meets the anchor
  // and the box grows up from it, edge-clamped horizontally.
  return (
    <div
      class={`tooltip-anchor ${anchorClass ?? ''}`}
      style={{left: `${left}px`, top: `${anchorY}px`, opacity: fade}}
    >
      {box}
    </div>
  );
}
