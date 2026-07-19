/**
 * UI root. Switches between screens via the `screen` signal. The game canvas
 * (Pixi) renders underneath, independent of this tree; screens overlay it.
 *
 * Battle HUD is built; menu / settings / depot are scaffolded here so they slot
 * in as components without touching the game or the canvas.
 */
import { screen, screenFlash } from './store';
import { Hud } from './Hud';

/** Full-viewport white-out for big blasts — sits above everything, incl. the HUD. */
function ScreenFlash() {
  const a = screenFlash.value;
  if (a <= 0.001) return null;
  return <div class="screen-flash" style={{ opacity: a }} />;
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
