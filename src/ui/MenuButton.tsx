/**
 * MenuButton — the one menu-list button shared by every menu screen (main menu,
 * the in-game "Game Menu" pause list, and the Settings root). It carries the shared
 * `.menu-btn` highlight treatment (a light box on hover; on click the photographic
 * NEGATIVE of whatever's behind it — an invert-rect selection) plus `.menu-item`
 * centering, so callers just supply the label and, where needed (Settings), hover
 * handlers to drive the bottom subtitle. `class` is for rare extra styling.
 */
import {BmpText, type FontId} from './BmpText';

export function MenuButton({
  label,
  font = 'bazouk-28',
  onClick,
  onEnter,
  onLeave,
  class: cls,
}: {
  label: string;
  font?: FontId;
  onClick?: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  class?: string;
}) {
  return (
    <button
      class={`menu-btn menu-item ${cls ?? ''}`}
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
