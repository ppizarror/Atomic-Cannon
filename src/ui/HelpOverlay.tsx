/**
 * Help overlay — the "?" control-panel button. The original opens an interactive
 * help/tutorial that highlights each panel control with its description (RE:
 * flag this+0x97f drives tutorial state this+0xa1c, whose text comes from the
 * per-control tooltip table FUN_0048a4f0). Our port presents the same reference
 * as a single modal: every control with what it does, grounded in those tooltips
 * and the confirmed mechanics. Freezes the sim while open (see openHelp).
 */
import {showHelp, closeHelp} from './store';
import {BmpText} from './BmpText';

// One row per panel control. Descriptions follow the original's tooltip table
// (FUN_0048a4f0) and confirmed behaviour; the reset line is the binary's verbatim
// text ("...set power and angle to your last shot").
const CONTROLS: { name: string; desc: string }[] = [
    {name: 'Select Weapon', desc: 'Pick a weapon from the list, or step through it with the ▲ ▼ arrows.'},
    {name: 'Power', desc: 'Set how hard you fire (10–1000). Drag the bar, or nudge it with + and −.'},
    {name: 'Angle', desc: 'Aim your barrel. Drag the dial, or turn it with the ◀ ▶ arrows.'},
    {name: 'FIRE', desc: 'Launch the selected weapon at your current power and angle.'},
    {name: 'Click to aim', desc: 'Click and drag near your tank to set angle and power together.'},
    {name: 'Reset  ↺', desc: 'Set power and angle back to your last shot.'},
    {name: 'Buy  $', desc: 'Open the Weapons Depot to purchase more weapons.'},
    {name: 'Menu  X', desc: 'Open the game menu — settings and quit.'},
    {name: 'Wind', desc: 'Shows the wind strength and direction, when wind is enabled.'},
    {name: 'Shot timer', desc: 'The bar under FIRE counts down your turn; forfeit if it runs out.'},
];

export function HelpOverlay() {
    if (!showHelp.value) return null;
    // Backdrop click closes; clicks inside the card don't bubble out to it.
    return (
        <div class="help-overlay" onClick={closeHelp}>
            <div class="help-card" onClick={e => e.stopPropagation()}>
                <div class="help-head"><BmpText font="bazouk-28" text="HELP"/></div>
                <div class="help-sub"><BmpText font="msans-14" text="Battle controls" tint="#c9d0d7"/></div>
                <div class="help-list">
                    {CONTROLS.map(c => (
                        <div class="help-row" key={c.name}>
                            <div class="help-name">{c.name}</div>
                            <div class="help-desc">{c.desc}</div>
                        </div>
                    ))}
                </div>
                <button class="metal-btn help-close" onClick={closeHelp}>Close</button>
            </div>
        </div>
    );
}
