/**
 * Main menu — the title screen. The `title.jpg` intro image
 * fills the background; the chrome "ATOMIC CANNON" title sits on top with a centered
 * vertical nav list (Play / Quick Play / Settings / Manual / About) in the game's bitmap fonts,
 * and the atom logo in the corner. Play opens the game-setup screen; Quick Play starts
 * immediately with the last-used setup; Settings/About navigate.
 */
import {
  openPlaySetup,
  quickPlay,
  openNetworkGame,
  openSettings,
  openManual,
  openAbout,
  openHighScores,
} from './store';
import {strings} from '../i18n';
import {BmpText} from './BmpText';
import {MenuButton} from './MenuButton';
import {MenuTargets} from './MenuTargets';
import {SplashBadge} from './SplashBadge';
import {useAsyncImage} from './useAsyncImage';
import {useMenuNav} from './useMenuNav';

// The atom logo bitmap has a black background; knock it out (alpha = luminance) so
// the metallic atom sits transparently in the corner.
function loadAtomLogo(): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      if (!g) {
        resolve(null);
        return;
      }
      g.drawImage(img, 0, 0);
      const im = g.getImageData(0, 0, c.width, c.height);
      const p = im.data;
      for (let i = 0; i < p.length; i += 4) p[i + 3] = Math.max(p[i], p[i + 1], p[i + 2]);
      g.putImageData(im, 0, 0);
      resolve(c.toDataURL());
    };
    img.onerror = () => resolve(null);
    img.src = '/assets/gui/atom.bmp';
  });
}

function AtomLogo() {
  const src = useAsyncImage(loadAtomLogo, []);
  return src ? <img class="mainmenu-logo" src={src} alt="" /> : null;
}

export function MainMenu() {
  const navRef = useMenuNav('mainmenu');
  // The `title.webp` intro image already carries the chrome "ATOMIC CANNON" logo,
  // so we don't render our own title over it — just the nav list.
  return (
    <div class="mainmenu">
      <MenuTargets />
      <SplashBadge />
      <div class="menu-list" ref={navRef}>
        <MenuButton label={strings.value.menu.play} onClick={openPlaySetup} />
        <MenuButton label={strings.value.menu.quickPlay} onClick={quickPlay} />
        <MenuButton label={strings.value.menu.network} onClick={openNetworkGame} />
        <MenuButton label={strings.value.menu.highScores} onClick={openHighScores} />
        <MenuButton label={strings.value.menu.settings} onClick={() => openSettings('menu')} />
        <MenuButton label={strings.value.menu.manual} onClick={openManual} />
        <MenuButton label={strings.value.menu.about} onClick={openAbout} />
      </div>
      <a
        class="mainmenu-repo"
        href={__REPO_URL__}
        target="_blank"
        rel="noopener noreferrer"
        title={__REPO_URL__}
      >
        <BmpText font="beijing-16-out" text={strings.value.menu.repoLabel} />
        <AtomLogo />
      </a>
      <div class="mainmenu-version">
        <BmpText font="beijing-16-out" text={`v${__APP_VERSION__}`} />
      </div>
    </div>
  );
}
