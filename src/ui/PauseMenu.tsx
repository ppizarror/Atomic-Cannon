/**
 * Pause menu — an overlay over the frozen battle (the in-game "Game Menu").
 * A centered list of bitmap-font items: Resume / Settings / Quit. Opened with ESC
 * (see main.tsx); Settings opens the audio settings over it and returns here on
 * close; Quit drops back to the main menu (UI).
 */
import {showPause, resumeGame, quitToMenu, openSettings} from './store';
import {BmpText} from './BmpText';
import {MenuButton} from './MenuButton';
import {strings} from '../i18n';

export function PauseMenu() {
  if (!showPause.value) return null;
  const p = strings.value.pause;
  return (
    <div class="overlay pause-overlay">
      <div class="pause-title">
        <BmpText font="beijing-16-out" text={p.title} />
      </div>
      <div class="menu-list">
        <MenuButton label={p.resume} onClick={resumeGame} />
        <MenuButton label={p.settings} onClick={() => openSettings('pause')} />
        <MenuButton label={p.quit} onClick={quitToMenu} />
      </div>
    </div>
  );
}
