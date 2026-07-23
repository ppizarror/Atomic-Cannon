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
import {BmpText} from './BmpText';
import {getSettingsPage} from './settingsPages';
import {WidgetRow} from './WidgetRow';
import {useForceRender} from './useForceRender';
import {ClassicScrollbar} from './ClassicScrollbar';

export function SettingsPage({id}: {id: string}) {
  const bump = useForceRender();
  const [sub, setSub] = useState<string | null>(null);

  // Re-render when fullscreen changes (e.g. Esc leaves it) so the Full Screen toggle
  // reflects the live state even without a click.
  useEffect(() => {
    document.addEventListener('fullscreenchange', bump);
    return () => document.removeEventListener('fullscreenchange', bump);
  }, [bump]);

  const page = getSettingsPage(id);
  if (!page) return null;

  return (
    <div class="settings-screen">
      <ClassicScrollbar class="settings-scroll">
        <div class="menu-list settings-rows">
          {page.rows.map((w, i) => (
            <WidgetRow key={i} w={w} bump={bump} onHover={setSub} />
          ))}
          <button
            class="settings-row srow-done menu-btn"
            onMouseEnter={() => setSub(strings.value.settings.pageDoneSub)}
            onMouseLeave={() => setSub(null)}
            onClick={settingsPageBack}
          >
            <BmpText font="bazouk-28" text={strings.value.settings.pageDone} />
          </button>
        </div>
      </ClassicScrollbar>
      <div class="settings-subtitle">
        <BmpText font="beijing-16-out" text={sub ?? page.header} />
      </div>
    </div>
  );
}
