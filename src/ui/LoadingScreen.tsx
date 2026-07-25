/**
 * Loading screen — shown while a freshly-launched match loads its landscape textures.
 * Reuses the main menu's title backdrop so the hand-off into a battle stays on-brand; the
 * caption is the game's bitmap-font "Loading" with 1→3 trailing dots cycling as a lightweight
 * "working" animation. Raised (see enterBattle) only until assetsReady() reveals the battle,
 * so the player never sees the gradient-sky / untextured-terrain fallback.
 */
import {useState, useEffect} from 'preact/hooks';
import {strings} from '../i18n';
import {BmpText} from './BmpText';

export function LoadingScreen() {
  // Start with NO dots and cycle 0→1→2→3→0, so a fast load that lifts the screen within the
  // first tick shows a clean "Loading" (never a lone trailing dot).
  const [dots, setDots] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDots(d => (d + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <div class="mainmenu loading-screen">
      {/* The dots hang off the right edge (absolute) so growing them never nudges the word. */}
      <div class="loading-caption">
        <BmpText font="bazouk-28" text={strings.value.app.loading} />
        <span class="loading-dots">
          <BmpText font="bazouk-28" text={'.'.repeat(dots)} />
        </span>
      </div>
    </div>
  );
}
