/**
 * Pause menu — an overlay over the frozen battle (the original's "Game Menu").
 * A centered list of bitmap-font items: Resume / Settings / Quit. Opened with ESC
 * (see main.tsx); Settings opens the audio settings over it and returns here on
 * close; Quit drops back to the main menu (UI).
 */
import { showPause, resumeGame, quitToMenu, openSettings } from './store';
import { BmpText } from './BmpText';

function PauseItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button class="pause-item" onClick={onClick}>
      <BmpText font="bazouk-28" text={label} />
    </button>
  );
}

export function PauseMenu() {
  if (!showPause.value) return null;
  return (
    <div class="pause-overlay">
      <div class="pause-title"><BmpText font="beijing-20-out" text="GAME PAUSED" /></div>
      <div class="pause-list">
        <PauseItem label="Resume" onClick={resumeGame} />
        <PauseItem label="Settings" onClick={openSettings} />
        <PauseItem label="Quit" onClick={quitToMenu} />
      </div>
    </div>
  );
}
