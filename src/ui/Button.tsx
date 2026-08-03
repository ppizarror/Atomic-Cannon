/**
 * Button — the metal action button for NON-metallic contexts (the editor screens' Done /
 * Prev / Next / Exit, over the steel plate or the game). The look lives in `.btn`:
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
import {BmpText, type FontId} from './BmpText';

export interface MetalButtonProps {
  label: string;
  font?: FontId;
  onClick?: () => void;
  disabled?: boolean;
  /** Extra class for layout/placement (e.g. `span`, `about-back`). */
  class?: string;
}

/**
 * The shared body of the two metal action buttons. They are deliberately kept as separate
 * NAMED components — which skin a button wears is a real design decision (see the file header
 * and ModalButton's), and callers should pick by context, not by passing a variant string. But
 * the markup is one line, so it lives here rather than being written twice.
 */
export function metalButton(skin: string, p: MetalButtonProps) {
  // The black-baked msans face reads on the grey button metal (no runtime recolour);
  // the disabled look comes from the CSS grayscale/brightness filter on `:disabled`.
  return (
    <button class={`${skin} ${p.class ?? ''}`} disabled={p.disabled} onClick={p.onClick}>
      <BmpText font={p.font ?? 'msans-14'} text={p.label} />
    </button>
  );
}

export function Button(p: MetalButtonProps) {
  return metalButton('btn', p);
}
