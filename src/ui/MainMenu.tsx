/**
 * Main menu — the title screen (the original's mode-5). The `title.jpg` intro image
 * fills the background; the chrome "ATOMIC CANNON" title sits on top with a centered
 * vertical nav list (Play / Settings / About) in the game's bitmap fonts, and the
 * atom logo in the corner. Play starts a fresh battle; Settings/About navigate.
 */
import { useEffect, useState } from 'preact/hooks';
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

// The atom logo bitmap has a black background; knock it out (alpha = luminance) so
// the metallic atom sits transparently in the corner.
function AtomLogo() {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let ok = true;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      if (!g) return;
      g.drawImage(img, 0, 0);
      const im = g.getImageData(0, 0, c.width, c.height);
      const p = im.data;
      for (let i = 0; i < p.length; i += 4) p[i + 3] = Math.max(p[i], p[i + 1], p[i + 2]);
      g.putImageData(im, 0, 0);
      if (ok) setSrc(c.toDataURL());
    };
    img.src = '/assets/gui/atom.bmp';
    return () => { ok = false; };
  }, []);
  return src ? <img class="mainmenu-logo" src={src} alt="" /> : null;
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
      <AtomLogo />
      <div class="mainmenu-version"><BmpText font="beijing-16-out" text={`v${__APP_VERSION__}`} /></div>
    </div>
  );
}
