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
import {ModalButton} from './ModalButton';
import {strings} from '../i18n';

// All text uses the game's OUTLINED bitmap fonts (baked white glyph + black
// outline), so it stays legible on the light dialog metal at any contrast.
// Outlined fonts can't be tinted (the fill floods the outline), so name vs.
// description are distinguished by font, not colour: a condensed BeijingSSK for
// the name, a clean Arial for the description.
export function HelpOverlay() {
  if (!showHelp.value) return null;
  const h = strings.value.help;
  // One row per panel control, each with a short description of what the control does.
  // Built during render so it reads strings.value reactively.
  const CONTROLS: {name: string; desc: string}[] = [
    {...h.controls.selectWeapon},
    {...h.controls.power},
    {...h.controls.angle},
    {...h.controls.fire},
    {...h.controls.clickAim},
    {...h.controls.reset},
    {...h.controls.buy},
    {...h.controls.menu},
    {...h.controls.wind},
    {...h.controls.shotTimer},
  ];
  return (
    <Modal
      backdrop="scrim"
      onClose={closeHelp}
      width="min(620px, 94vw)"
      maxHeight="88vh"
      class="help-card"
    >
      <div class="help-head">
        <BmpText font="bazouk-28" text={h.title} />
      </div>
      <div class="help-sub">
        <BmpText font="arial-14-out" text={h.subtitle} />
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
      <ModalButton label={h.close} onClick={closeHelp} class="help-close" />
    </Modal>
  );
}
