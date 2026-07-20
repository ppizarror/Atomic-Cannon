/**
 * MenuButton — the one menu-list button shared by every menu screen (main menu,
 * the in-game "Game Menu" pause list, and the Settings root). It carries the shared
 * `.menu-btn` highlight treatment: a light box on hover, and on click the
 * photographic NEGATIVE of whatever's behind it — the original's invert-rect
 * selection. Callers add a layout class for spacing and, where needed (Settings),
 * hover handlers to drive the bottom subtitle.
 */
import { BmpText, type FontId } from './BmpText';

export function MenuButton({ label, font = 'bazouk-28', onClick, onEnter, onLeave, class: cls }: {
  label: string;
  font?: FontId;
  onClick?: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  class?: string;
}) {
  return (
    <button
      class={`menu-btn ${cls ?? ''}`}
      onClick={onClick}
      onMouseEnter={onEnter}
      onFocus={onEnter}
      onMouseLeave={onLeave}
      onBlur={onLeave}
    >
      <BmpText font={font} text={label} />
    </button>
  );
}
