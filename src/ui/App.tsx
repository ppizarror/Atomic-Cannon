/**
 * UI root. Switches between screens via the `screen` signal. The game canvas
 * (Pixi) renders underneath, independent of this tree; screens overlay it.
 *
 * Battle HUD is built; menu / settings / depot are scaffolded here so they slot
 * in as components without touching the game or the canvas.
 */
import { screen, screenFlash, screenFlashColor } from './store';
import { Hud } from './Hud';

/**
 * Full-viewport flash for big blasts — sits above everything, incl. the HUD.
 * It inherits the bomb's colour, mixed toward white by intensity: a blinding
 * near-white at the peak that recedes to the weapon's hue (uranium red, …).
 */
function ScreenFlash() {
  const a = screenFlash.value;
  if (a <= 0.001) return null;
  const n = parseInt(screenFlashColor.value.slice(1), 16);
  let cr = (n >> 16) & 255, cg = (n >> 8) & 255, cb = n & 255;
  // Saturate toward the dominant hue so a warm tint reads vivid (uranium's light
  // orange → red-orange), not washed-out sepia — then mix toward white by intensity.
  const mx = Math.max(cr, cg, cb, 1);
  const sat = (ch: number) => (ch >= mx ? ch : ch * 0.5);
  cr = sat(cr); cg = sat(cg); cb = sat(cb);
  const w = Math.min(1, a * a);   // whiter near the peak, hue shows as it fades
  const mix = (ch: number) => Math.round(ch + (255 - ch) * w);
  return (
    <div
      class="screen-flash"
      style={{ background: `rgb(${mix(cr)},${mix(cg)},${mix(cb)})`, opacity: Math.min(1, a * 1.15) }}
    />
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <div class="screen-overlay">
      <div class="screen-card">
        <h1>{title}</h1>
        <p>Coming soon.</p>
        <button class="metal-btn" onClick={() => (screen.value = 'battle')}>Back to battle</button>
      </div>
    </div>
  );
}

function CurrentScreen() {
  switch (screen.value) {
    case 'battle': return <Hud />;
    case 'menu': return <Placeholder title="Atomic Cannon" />;
    case 'settings': return <Placeholder title="Settings" />;
    case 'depot': return <Placeholder title="Weapons Depot" />;
    default: return <Hud />;
  }
}

export function App() {
  return (
    <>
      <CurrentScreen />
      <ScreenFlash />
    </>
  );
}
