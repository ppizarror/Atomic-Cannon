/**
 * A single option page in the Settings tree (Gameplay / Audio / …). Renders the
 * page's widget rows over the same darkened title backdrop as the root: two-column
 * rows with the label LEFT and the value RIGHT. Cyclable
 * rows (enum / stepper) frame the value with `‹ … ›` cycle arrows (rendered as
 * `<`/`>`, the glyphs the bitmap fonts carry); toggles show `ON`/`OFF` with no
 * arrows. A centered `Done` returns to the Settings root. Hovering a row shows its
 * description centered along the bottom edge; with nothing hovered the page's own
 * header line shows there instead.
 */
import {useEffect, useState} from 'preact/hooks';
import {strings} from '../i18n';
import {settingsPageBack} from './store';
import {BigButton} from './BigButton';
import {MenuScreen} from './MenuScreen';
import {getSettingsPage} from './settingsPages';
import {WidgetRow} from './WidgetRow';
import {useForceRender} from './useForceRender';
import {useMenuNav} from './useMenuNav';

export function SettingsPage({id}: {id: string}) {
  const bump = useForceRender();
  const [sub, setSub] = useState<string | null>(null);
  const navRef = useMenuNav(`settings:${id}`);

  // Re-render when fullscreen changes (e.g. Esc leaves it) so the Full Screen toggle
  // reflects the live state even without a click.
  useEffect(() => {
    document.addEventListener('fullscreenchange', bump);
    return () => document.removeEventListener('fullscreenchange', bump);
  }, [bump]);

  const page = getSettingsPage(id);
  if (!page) return null;

  return (
    <MenuScreen subtitle={sub ?? page.header}>
      <div class="menu-list settings-rows" ref={navRef}>
        {page.rows.map((w, i) => (
          <WidgetRow key={i} w={w} bump={bump} onHover={setSub} />
        ))}
        <BigButton
          label={strings.value.settings.pageDone}
          onEnter={() => setSub(strings.value.settings.pageDoneSub)}
          onLeave={() => setSub(null)}
          onClick={settingsPageBack}
        />
      </div>
    </MenuScreen>
  );
}
