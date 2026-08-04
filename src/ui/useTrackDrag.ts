/**
 * Drag along a track (the desktop power meter, the mobile power/angle sliders) — the pointer's
 * position within the element's box as a 0..1 fraction, plus the turn guard both controls need.
 *
 * The guard is the part worth sharing: the turn is captured on GRAB, and a move stops applying if
 * the turn changed mid-drag. A shot-clock forfeit hands off without ever sending a pointerup, and
 * pointer capture keeps delivering moves straight past the `blocked` CSS — so without this, a drag
 * begun on your own turn would keep writing power/angle into the next player's.
 *
 * Spread the result onto the track element: `<div {...useTrackDrag('y', setPower)} />` — it carries
 * the ref and the pointer handlers from {@link usePointerDrag}.
 */
import {useRef} from 'preact/hooks';
import type {RefObject, TargetedPointerEvent} from 'preact';
import {clamp01} from '../math/num';
import {usePointerDrag} from './usePointerDrag';
import {game} from './store';

export function useTrackDrag<T extends HTMLElement>(
  /** `y` measures top→bottom (the vertical meter), `x` measures left→right (the sliders). */
  axis: 'x' | 'y',
  /** Called with the pointer's 0..1 position along the track, on grab and on every held move. */
  apply: (frac: number) => void,
): {
  ref: RefObject<T>;
  onPointerDown: (e: TargetedPointerEvent<T>) => void;
  onPointerMove: (e: TargetedPointerEvent<T>) => void;
  onPointerUp: (e: TargetedPointerEvent<T>) => void;
  onPointerCancel: (e: TargetedPointerEvent<T>) => void;
} {
  const ref = useRef<T>(null);
  const grabSeq = useRef(0);

  const fromEvent = (e: TargetedPointerEvent<T>): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const frac =
      axis === 'y' ? clamp01((e.clientY - rect.top) / rect.height) : clamp01((e.clientX - rect.left) / rect.width);
    if (game().turnSeq() === grabSeq.current) apply(frac);
  };

  const drag = usePointerDrag<T>({
    onStart: e => {
      grabSeq.current = game().turnSeq(); // …so the check in fromEvent passes for this grab
      fromEvent(e);
    },
    onMove: fromEvent,
  });

  return {ref, ...drag};
}
