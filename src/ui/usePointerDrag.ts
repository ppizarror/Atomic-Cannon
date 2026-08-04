/**
 * The pointer-capture drag triad every drag control repeated (power meter, aim dial, colour
 * picker): on down, capture the pointer — so it keeps tracking when the cursor slips off the
 * element — and start; on move, update while held; on release (or cancel), drop the capture.
 * Spread the returned handlers onto the target; supply `onStart`/`onMove` for the
 * control-specific work (read the event, set the value / stash the drag origin).
 */
import {useRef} from 'preact/hooks';
import type {TargetedPointerEvent} from 'preact';

type PointerHandler<T extends HTMLElement> = (e: TargetedPointerEvent<T>) => void;

export function usePointerDrag<T extends HTMLElement>(handlers: {
  onStart?: PointerHandler<T>;
  onMove: PointerHandler<T>;
}): {
  onPointerDown: PointerHandler<T>;
  onPointerMove: PointerHandler<T>;
  onPointerUp: PointerHandler<T>;
  onPointerCancel: PointerHandler<T>;
} {
  const dragging = useRef(false);
  const end: PointerHandler<T> = e => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  return {
    onPointerDown(e) {
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      handlers.onStart?.(e);
      e.preventDefault();
    },
    onPointerMove(e) {
      if (dragging.current) handlers.onMove(e);
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}
