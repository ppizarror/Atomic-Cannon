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
import {closeSettings, settingsOrigin, settingsPage, openSettingsPage} from './store';
import {BmpText} from './BmpText';
import {MenuButton} from './MenuButton';
import {SettingsPage} from './SettingsPage';
import {WeaponsEditor, LandscapesEditor} from './EnableListEditor';
import {ControlsEditor} from './ControlsEditor';
import {PlayersEditor} from './PlayersEditor';

interface Entry {
  label: string;
  /** Bottom-center subtitle shown on hover (the option's description). */
  sub: string;
  onClick: () => void;
}

// The root categories, with their exact hover subtitles. The Audio "razzle
// dazzle" line and the "(quits current game)" warnings are intentional game
// strings — quirks and all. Each opens its option page; Customize Controls and
// Customize Players open their dedicated editor screens.
const CATEGORIES: Entry[] = [
  {
    label: 'Economy Options',
    sub: 'Adjust economic settings',
    onClick: () => openSettingsPage('economy'),
  },
  {label: 'Tank Options', sub: 'Adjust tank settings', onClick: () => openSettingsPage('tank')},
  {
    label: 'Gameplay Options',
    sub: 'Adjust gameplay settings',
    onClick: () => openSettingsPage('gameplay'),
  },
  {
    label: 'Graphics Options',
    sub: 'Adjust graphics settings',
    onClick: () => openSettingsPage('graphics'),
  },
  {
    label: 'Audio Options',
    sub: 'In game razzle dazzle soundfecta',
    onClick: () => openSettingsPage('audio'),
  },
  {
    label: 'Game Content',
    sub: 'Enable specific weapons and landscapes',
    onClick: () => openSettingsPage('content'),
  },
  {
    label: 'Customize Controls',
    sub: 'Define custom buttons for game actions',
    onClick: () => openSettingsPage('controls'),
  },
  {
    label: 'Customize Players',
    sub: 'Define custom names and colors (quits current game)',
    onClick: () => openSettingsPage('players'),
  },
];

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
  if (p !== 'root') return <SettingsPage id={p} />;
  return <SettingsRoot />;
}

function SettingsRoot() {
  const [sub, setSub] = useState('');
  // Done closes Settings. The default subtitle is "Return to the main menu"; when we
  // reached Settings from the in-game pause it returns to the game instead, so the
  // hint follows where Done actually goes.
  const done: Entry = {
    label: 'Done',
    sub: settingsOrigin.value === 'pause' ? 'Return to the game' : 'Return to the main menu',
    onClick: closeSettings,
  };
  return (
    <div class="settings-screen">
      <div class="menu-list settings-list">
        {CATEGORIES.map(e => (
          <SettingsItem key={e.label} entry={e} onHover={setSub} />
        ))}
        <SettingsItem key="Done" entry={done} onHover={setSub} />
      </div>
      <div class="settings-subtitle">
        {sub ? <BmpText font="msans-14" text={sub} tint="#eef2f6" /> : null}
      </div>
    </div>
  );
}
