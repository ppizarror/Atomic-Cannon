/**
 * Pause menu — an overlay over the frozen battle (the in-game "Game Menu").
 * A centered list of bitmap-font items: Resume / Settings / Quit. Opened with ESC
 * (see main.tsx); Settings opens the audio settings over it and returns here on
 * close; Quit drops back to the main menu (UI).
 */
import { showPause, resumeGame, quitToMenu, openSettings } from './store';
import { BmpText } from './BmpText';
import { MenuButton } from './MenuButton';

export function PauseMenu() {
  if (!showPause.value) return null;
  return (
    <div class="pause-overlay">
      <div class="pause-title"><BmpText font="beijing-20-out" text="GAME PAUSED" /></div>
      <div class="pause-list">
        <MenuButton label="Resume" onClick={resumeGame} class="pause-item" />
        <MenuButton label="Settings" onClick={() => openSettings('pause')} class="pause-item" />
        <MenuButton label="Quit" onClick={quitToMenu} class="pause-item" />
      </div>
    </div>
  );
}
