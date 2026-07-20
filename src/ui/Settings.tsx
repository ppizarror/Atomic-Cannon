/**
 * Settings / Options root. Rendered over the same
 * darkened title backdrop as the main menu — the brushed-steel plate is only used
 * by the deeper editor sub-screens (weapon / landscape enable lists). A centered
 * vertical list of category entries in the game's outlined bitmap font; hovering an
 * entry shows its one-line description centered along the bottom edge. `Done`
 * returns to whichever menu opened Settings (the pause menu or the main menu).
 *
 * Each category opens its option page (`SettingsPage`); Customize Controls / Players
 * are dedicated editor screens that aren't built yet (audible click only).
 */
import { useState } from 'preact/hooks';
import { closeSettings, settingsOrigin, settingsPage, openSettingsPage, uiClick } from './store';
import { BmpText } from './BmpText';
import { MenuButton } from './MenuButton';
import { SettingsPage } from './SettingsPage';

interface Entry {
  label: string;
  /** Bottom-center subtitle shown on hover (the option's description). */
  sub: string;
  onClick: () => void;
}

// The nine root categories, with their exact hover subtitles. The Audio "razzle
// dazzle" line and the "(quits current game)" warnings are intentional game
// strings — quirks and all. Each opens its option page; Customize
// Controls / Players open dedicated editor screens (not built yet — inert click).
const CATEGORIES: Entry[] = [
  { label: 'Economy Options', sub: 'Adjust economic settings', onClick: () => openSettingsPage('economy') },
  { label: 'Tank Options', sub: 'Adjust tank settings', onClick: () => openSettingsPage('tank') },
  { label: 'Gameplay Options', sub: 'Adjust gameplay settings', onClick: () => openSettingsPage('gameplay') },
  { label: 'Graphics Options', sub: 'Adjust graphics settings', onClick: () => openSettingsPage('graphics') },
  { label: 'Audio Options', sub: 'In game razzle dazzle soundfecta', onClick: () => openSettingsPage('audio') },
  { label: 'Game Content', sub: 'Enable specific weapons and landscapes', onClick: () => openSettingsPage('content') },
  { label: 'Customize Controls', sub: 'Define custom buttons for game actions', onClick: uiClick },
  { label: 'Customize Players', sub: 'Define custom names and colors (quits current game)', onClick: uiClick },
];

function SettingsItem({ entry, onHover }: { entry: Entry; onHover: (s: string) => void }) {
  return (
    <MenuButton
      label={entry.label}
      onClick={entry.onClick}
      onEnter={() => onHover(entry.sub)}
      onLeave={() => onHover('')}
      class="settings-item"
    />
  );
}

export function Settings() {
  // Sub-page open? Render it instead of the category list.
  if (settingsPage.value !== 'root') return <SettingsPage id={settingsPage.value} />;
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
      <div class="settings-list">
        {CATEGORIES.map((e) => (
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
