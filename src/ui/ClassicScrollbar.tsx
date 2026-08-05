/**
 * ClassicScrollbar — a scroll container whose native scrollbar is hidden and
 * replaced by a custom bar: a flat black track with a solid white
 * rectangular "control" (hard corners, no border, no inset margin).
 *
 * macOS renders the native ::-webkit-scrollbar thumb as a rounded, edge-inset
 * pill that `border-radius: 0` can't square off, so we draw our own track + grip
 * and drive the real (still native) scroll underneath — the view keeps wheel,
 * keyboard and `scrollIntoView` behaviour; only the visible bar is ours.
 *
 * Drop-in for a scrolling <div>: `class` and `style` land on the outer box (put
 * border / background / flex sizing there), `rootRef` points at that box, `viewRef`
 * at the scrolling element inside it, and any extra props (onMouseMove…) are
 * forwarded to that scrolling element.
 */
import {useCallback, useLayoutEffect, useRef, useState} from 'preact/hooks';
import type {
  ComponentChildren,
  CSSProperties,
  HTMLAttributes,
  RefObject,
  TargetedEvent,
  TargetedPointerEvent,
} from 'preact';

type Props = {
  class?: string;
  style?: CSSProperties;
  rootRef?: RefObject<HTMLDivElement>;
  /** The element that actually SCROLLS (inside the host `rootRef` points at) — what a caller needs
   *  to read or restore `scrollTop`. */
  viewRef?: RefObject<HTMLDivElement>;
  children?: ComponentChildren;
} & Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'style' | 'children' | 'ref'>;

const MIN_GRIP = 22; // px — the grip never shrinks below this, however long the list

export function ClassicScrollbar({
  class: cls = '',
  style,
  rootRef,
  viewRef: outRef,
  children,
  onScroll,
  ...rest
}: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  // Hand the scrolling element out. A layout effect rather than a second `ref=` (Preact takes one)
  // — and it lands in time: a child's layout effects run before its parent's, so a caller restoring
  // a saved scrollTop in its own useLayoutEffect already sees the element.
  useLayoutEffect(() => {
    if (outRef) outRef.current = viewRef.current;
  }, [outRef]);
  const [grip, setGrip] = useState({top: 0, height: 0, show: false});
  // Removes the active grip-drag's window listeners; set while dragging, cleared on pointer-up. An
  // unmount MID-DRAG (e.g. the depot auto-closes on a net turn hand-off) would otherwise leak them.
  const dragCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => dragCleanup.current?.(), []);

  // Recompute grip size/position from the live scroll metrics.
  const sync = useCallback(() => {
    const el = viewRef.current;
    if (!el) return;
    const {scrollTop, scrollHeight, clientHeight} = el;
    if (scrollHeight <= clientHeight + 1) {
      setGrip(g => (g.show ? {top: 0, height: 0, show: false} : g));
      return;
    }
    const height = Math.max(MIN_GRIP, (clientHeight / scrollHeight) * clientHeight);
    const travel = clientHeight - height;
    const range = scrollHeight - clientHeight;
    const top = range > 0 ? (scrollTop / range) * travel : 0;
    setGrip({top, height, show: true});
  }, []);

  // Re-sync on mount, on content/size change, and whenever the children change.
  useLayoutEffect(() => {
    sync();
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [sync, children]);

  // Drag the grip → scroll the view proportionally (window listeners so the drag
  // keeps tracking even when the pointer leaves the narrow bar).
  const onGripDown = (e: TargetedPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = viewRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startTop = el.scrollTop;
    const travel = el.clientHeight - grip.height; // px the grip can move
    const range = el.scrollHeight - el.clientHeight; // px the content can scroll
    if (travel <= 0 || range <= 0) return;
    const move = (ev: PointerEvent) => {
      el.scrollTop = startTop + ((ev.clientY - startY) / travel) * range;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragCleanup.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    dragCleanup.current = up; // so an unmount mid-drag removes these
  };

  // The grip MUST re-sync on every scroll, so a caller's own onScroll is composed with `sync`
  // rather than spread over it ({...rest} lands after the handler and would silently replace it).
  const scrolled = (e: TargetedEvent<HTMLDivElement, Event>) => {
    sync();
    onScroll?.(e);
  };

  return (
    <div class={`cscroll-host ${cls}`} style={style} ref={rootRef}>
      <div class="cscroll-view" ref={viewRef} onScroll={scrolled} {...rest}>
        {children}
      </div>
      {grip.show && (
        <div class="cscroll-bar">
          <div
            class="cscroll-grip"
            style={{top: `${grip.top}px`, height: `${grip.height}px`}}
            onPointerDown={onGripDown}
          />
        </div>
      )}
    </div>
  );
}
