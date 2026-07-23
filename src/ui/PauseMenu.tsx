/**
 * Pause menu — an overlay over the frozen battle (the in-game "Game Menu").
 * A centered list of bitmap-font items: Resume / Settings / Quit. Opened with ESC
 * (see main.tsx); Settings opens the audio settings over it and returns here on
 * close; Quit drops back to the main menu (UI).
 */
import {showPause, resumeGame, quitToMenu, openSettings} from './store';
import {netState, leaveMatch} from './networkStore';
import {BmpText} from './BmpText';
import {MenuButton} from './MenuButton';
import {strings} from '../i18n';

export function PauseMenu() {
  if (!showPause.value) return null;
  const p = strings.value.pause;
  // Quitting a networked battle must also leave the room (so the other player isn't
  // left waiting on a ghost); a solo battle just drops to the menu.
  const inNetMatch = netState.value.phase === 'playing';
  const onQuit = inNetMatch
    ? () => {
        resumeGame(); // close the overlay + unfreeze before leaving
        leaveMatch();
      }
    : quitToMenu;
  return (
    <div class="overlay pause-overlay">
      <div class="pause-title">
        <BmpText font="beijing-16-out" text={p.title} />
      </div>
      <div class="menu-list">
        <MenuButton label={p.resume} onClick={resumeGame} />
        <MenuButton label={p.settings} onClick={() => openSettings('pause')} />
        <MenuButton label={inNetMatch ? strings.value.net.endMatch : p.quit} onClick={onQuit} />
      </div>
    </div>
  );
}
