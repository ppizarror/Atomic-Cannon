/**
 * Help overlay — the "?" control-panel button. Opens a help reference that lists
 * each panel control with its description, presented as a single modal rendered on
 * the game's `atomic/dialog.bmp` panel with the game's bitmap fonts. Freezes the
 * sim while open (see openHelp).
 *
 * Text is ASCII-only and one line per field: the bitmap fonts cover ASCII 33..126
 * (no arrows / en-dash / middle-dot) and BmpText does not wrap.
 */
import {showHelp, closeHelp} from './store';
import {BmpText} from './BmpText';
import {Modal} from './Modal';

// One row per panel control, each with a short description of what the control does.
const CONTROLS: {name: string; desc: string}[] = [
  {name: 'Select Weapon', desc: 'Choose from the list, or step with the arrows.'},
  {name: 'Power', desc: 'How hard you fire, 10 to 1000. Drag or +/-.'},
  {name: 'Angle', desc: 'Aim your barrel. Drag the dial or use arrows.'},
  {name: 'FIRE', desc: 'Launch the weapon at your power and angle.'},
  {name: 'Click to Aim', desc: 'Drag near your tank to set angle and power.'},
  {name: 'Reset', desc: 'Set power and angle back to your last shot.'},
  {name: 'Buy  $', desc: 'Open the Weapons Depot to buy weapons.'},
  {name: 'Menu  X', desc: 'Open the game menu: settings and quit.'},
  {name: 'Wind', desc: 'Wind strength and direction, when enabled.'},
  {name: 'Shot Timer', desc: 'The bar under FIRE counts down your turn.'},
];

// All text uses the game's OUTLINED bitmap fonts (baked white glyph + black
// outline), so it stays legible on the light dialog metal at any contrast.
// Outlined fonts can't be tinted (the fill floods the outline), so name vs.
// description are distinguished by font, not colour: a condensed BeijingSSK for
// the name, a clean Arial for the description.
export function HelpOverlay() {
  if (!showHelp.value) return null;
  return (
    <Modal
      backdrop="scrim"
      onClose={closeHelp}
      width="min(620px, 94vw)"
      maxHeight="88vh"
      class="help-card"
    >
      <div class="help-head">
        <BmpText font="bazouk-28" text="HELP" />
      </div>
      <div class="help-sub">
        <BmpText font="arial-14-out" text="Battle Controls" />
      </div>
      <div class="help-list">
        {CONTROLS.map(c => (
          <div class="help-row" key={c.name}>
            <div class="help-name">
              <BmpText font="beijing-16-out" text={c.name} spacing={-1} />
            </div>
            <div class="help-desc">
              <BmpText font="arial-14-out" text={c.desc} />
            </div>
          </div>
        ))}
      </div>
      <button class="help-close" onClick={closeHelp}>
        <BmpText font="beijing-16-out" text="Close" />
      </button>
    </Modal>
  );
}
