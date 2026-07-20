/**
 * Main menu — the title screen (the original's mode-5). The `title.jpg` intro image
 * fills the background; the chrome "ATOMIC CANNON" title sits on top with a centered
 * vertical nav list (Play / Settings / About) in the game's bitmap fonts, and the
 * atom logo in the corner. Play starts a fresh battle; Settings/About navigate.
 */
import { playNewGame, openSettings, openAbout } from './store';
import { BmpText } from './BmpText';
import { MenuTargets } from './MenuTargets';

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button class="mainmenu-item" onClick={onClick}>
      <BmpText font="bazouk-28" text={label} />
    </button>
  );
}

export function MainMenu() {
  // The `title.webp` intro image already carries the chrome "ATOMIC CANNON" logo,
  // so we don't render our own title over it — just the nav list.
  return (
    <div class="mainmenu">
      <MenuTargets />
      <div class="mainmenu-list">
        <MenuItem label="Play" onClick={playNewGame} />
        <MenuItem label="Settings" onClick={() => openSettings('menu')} />
        <MenuItem label="About" onClick={openAbout} />
      </div>
      <img class="mainmenu-logo" src="/assets/gui/atom.bmp" alt="" />
    </div>
  );
}
