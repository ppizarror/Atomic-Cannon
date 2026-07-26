/**
 * SplashBadge — an oscillating "splash" tagline pinned to the bottom-right of the
 * title logo, flagging this build as an unofficial, open-source recreation. One
 * tagline is chosen at random per mount (i.e. each time the main menu appears),
 * and it pulses in scale via a CSS keyframe.
 *
 * The text is drawn with the game's own bitmap font (`arial-black-16-out`) — like
 * every other label in the UI — so we never invent a web font. The scale pulse is
 * a CSS transform on the wrapper, so the rendered glyph canvas is never re-rastered.
 */
import {useState} from 'preact/hooks';
import {strings} from '../i18n';
import {BmpText} from './BmpText';

export function SplashBadge() {
  const list = strings.value.menu.splashes;
  // Pick once per mount; the initializer runs a single time so the tagline is
  // stable while this menu is shown but re-randomises on the next visit.
  const [text] = useState(() => list[Math.floor(Math.random() * list.length)] ?? '');
  if (!text) return null;
  return (
    <div class="mainmenu-splash" aria-hidden="true">
      <span class="mainmenu-splash-text">
        <BmpText font="arial-black-16-out" text={text} scale={2} />
      </span>
    </div>
  );
}
