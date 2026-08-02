/**
 * The four-handler set every hoverable menu row wires identically: pointer enter/leave AND
 * focus/blur, both pairs driving the same callback. Keyboard navigation (`useMenuNav`) moves
 * FOCUS rather than the pointer, so a row that only listens for mouse events leaves the
 * bottom-of-screen hover subtitle stale when you arrow through the list — which is why the
 * focus pair always has to accompany the mouse pair.
 */
export function hoverProps(
  onEnter?: () => void,
  onLeave?: () => void,
): {
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
} {
  return {onMouseEnter: onEnter, onMouseLeave: onLeave, onFocus: onEnter, onBlur: onLeave};
}
