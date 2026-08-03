/**
 * Settings / Options root. Rendered over the same
 * darkened title backdrop as the main menu — the brushed-steel plate is only used
 * by the deeper editor sub-screens (weapon / landscape enable lists). A centered
 * vertical list of category entries in the game's outlined bitmap font; hovering an
 * entry shows its one-line description centered along the bottom edge. `Done`
 * returns to whichever menu opened Settings (the pause menu or the main menu).
 *
 * Each category opens its option page (`SettingsPage`); Customize Controls and Customize
 * Players open their dedicated editor screens (key bindings / the player roster).
 */
import {useState} from 'preact/hooks';
import {strings} from '../i18n';
import {closeSettings, settingsOrigin, settingsPage, openSettingsPage} from './store';
import {MenuButton} from './MenuButton';
import {useMenuNav} from './useMenuNav';
import {MenuScreen} from './MenuScreen';
import {SettingsPage} from './SettingsPage';
import {WeaponsEditor, LandscapesEditor} from './EnableListEditor';
import {ControlsEditor} from './ControlsEditor';
import {PlayersEditor} from './PlayersEditor';
import {TauntEditor} from './TauntEditor';
import {ImportExportEditor} from './ImportExportEditor';
import {SyncEditor} from './SyncEditor';

interface Entry {
  label: string;
  /** Bottom-center subtitle shown on hover (the option's description). */
  sub: string;
  onClick: () => void;
}

// The root categories, sourced from i18n (label + hover subtitle). The Audio "razzle
// dazzle" line and the "(quits current game)" warnings are intentional game strings —
// quirks and all. Each opens its option page; Customize Controls / Players / Taunts open
// their dedicated editor screens.
function categories(): Entry[] {
  const c = strings.value.settings.categories;
  const item = (e: {label: string; sub: string}, page: string): Entry => ({
    label: e.label,
    sub: e.sub,
    onClick: () => openSettingsPage(page),
  });
  return [
    item(c.economy, 'economy'),
    item(c.tank, 'tank'),
    item(c.gameplay, 'gameplay'),
    item(c.graphics, 'graphics'),
    item(c.audio, 'audio'),
    item(c.content, 'content'),
    item(c.controls, 'controls'),
    item(c.players, 'players'),
    item(c.taunts, 'taunts'),
    item(c.importExport, 'importExport'),
    item(c.sync, 'sync'),
  ];
}

function SettingsItem({entry, onHover}: {entry: Entry; onHover: (s: string) => void}) {
  return (
    <MenuButton
      label={entry.label}
      onClick={entry.onClick}
      onEnter={() => onHover(entry.sub)}
      onLeave={() => onHover('')}
    />
  );
}

export function Settings() {
  // Sub-page open? Render the matching screen instead of the category list.
  const p = settingsPage.value;
  if (p === 'content.weapons') return <WeaponsEditor />;
  if (p === 'content.landscapes') return <LandscapesEditor />;
  if (p === 'controls') return <ControlsEditor />;
  if (p === 'players') return <PlayersEditor />;
  if (p === 'taunts') return <TauntEditor />;
  if (p === 'importExport') return <ImportExportEditor />;
  if (p === 'sync') return <SyncEditor />;
  if (p !== 'root') return <SettingsPage id={p} />;
  return <SettingsRoot />;
}

function SettingsRoot() {
  const [sub, setSub] = useState('');
  const navRef = useMenuNav('settings-root');
  // Done closes Settings. The default subtitle is "Return to the main menu"; when we
  // reached Settings from the in-game pause it returns to the game instead, so the
  // hint follows where Done actually goes.
  const s = strings.value.settings;
  const done: Entry = {
    label: s.done,
    sub: settingsOrigin.value === 'pause' ? s.doneSubGame : s.doneSubMenu,
    onClick: closeSettings,
  };
  return (
    <MenuScreen subtitle={sub}>
      <div class="menu-list settings-rows" ref={navRef}>
        {categories().map(e => (
          <SettingsItem key={e.label} entry={e} onHover={setSub} />
        ))}
        <SettingsItem key="Done" entry={done} onHover={setSub} />
      </div>
    </MenuScreen>
  );
}
