/**
 * Button — the metal action button for NON-metallic contexts (the Placeholder "Back
 * to battle" over the game, the enable-list Prev/Next/Exit). The look lives in `.btn`:
 * the game's `atomic/button` art with its 2px magenta checkerboard border cropped off
 * (→ `atomic/button.png`, fully opaque), 9-sliced so the bevel border is identical at
 * every width; here it just carries the bitmap-font label.
 *
 * Pairs with <ModalButton>, which is the SAME API but uses `buy button.bmp` for buttons
 * that sit on metallic panels (the dialog modals + the depot). <MenuButton> is the
 * separate menu-list invert-rect button.
 *
 * NB: `atomic/button.png` is a fully-opaque copy of the legacy atomic button sprite with
 * its 2px magenta checkerboard border cropped off. The raw magenta-keyed sprite can't be
 * used directly in CSS — magenta + dither render as ragged edges / "boxes" when stretched
 * — so the pre-cropped PNG is committed and 9-sliced by `.btn`.
 */
import { BmpText, type FontId } from './BmpText';

export function Button({ label, font = 'msans-14', onClick, disabled, tint = '#14171a', class: cls }: {
  label: string;
  font?: FontId;
  onClick?: () => void;
  disabled?: boolean;
  /** Label colour (dark ink on the grey button face by default; greyed when disabled). */
  tint?: string;
  /** Extra class for layout/placement (e.g. `span`, `about-back`). */
  class?: string;
}) {
  return (
    <button class={`btn ${cls ?? ''}`} disabled={disabled} onClick={onClick}>
      <BmpText font={font} text={label} tint={disabled ? '#6b7075' : tint} />
    </button>
  );
}
