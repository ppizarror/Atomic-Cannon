/**
 * ModalButton — a metal action button for use ON metallic panels: the dialog modals
 * (About / Help) and the weapons depot (itself a modal). Renders the game's own
 * `buy button.bmp` brushed-metal button art — the depot's original, proven look, which
 * blends into those metallic surfaces.
 *
 * Pairs with <Button>, which uses the `atomic/button` art for NON-metallic contexts
 * (e.g. over the battle, the enable-list editor). Same API as <Button>; the only
 * difference is the button skin (`.modal-btn` vs `.btn`). Both carry a bitmap-font
 * label; <MenuButton> remains the separate menu-list invert-rect button.
 */
import {BmpText, type FontId} from './BmpText';

export function ModalButton({
  label,
  font = 'msans-14',
  onClick,
  disabled,
  class: cls,
}: {
  label: string;
  font?: FontId;
  onClick?: () => void;
  disabled?: boolean;
  /** Extra class for layout/placement (e.g. `span`, `about-back`, `dep-btn`). */
  class?: string;
}) {
  return (
    <button class={`modal-btn ${cls ?? ''}`} disabled={disabled} onClick={onClick}>
      <BmpText font={font} text={label} />
    </button>
  );
}
