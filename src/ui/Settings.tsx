/**
 * Settings / Options root (the original's settings tree over `steel.jpg`). A
 * centered vertical list of category entries in the game's outlined bitmap font;
 * hovering an entry shows its one-line description centered along the bottom edge,
 * exactly like the retail options screen. `Done` returns to whichever menu opened
 * Settings (the pause menu or the main menu).
 *
 * The individual option pages (Audio / Gameplay / …) are the next step; for now the
 * category entries are inert (audible click only) and `Done` is wired.
 */
import { useState } from 'preact/hooks';
import { closeSettings, settingsOrigin, uiClick } from './store';
import { BmpText } from './BmpText';

interface Entry {
  label: string;
  /** Bottom-center subtitle shown on hover (verbatim from the retail options menu). */
  sub: string;
  onClick: () => void;
}

// The nine root categories, with their exact hover subtitles. The Audio "razzle
// dazzle" line and the "(quits current game)" warnings are the original's own
// strings — kept verbatim, quirks and all.
const CATEGORIES: Entry[] = [
  { label: 'Economy Options', sub: 'Adjust economic settings', onClick: uiClick },
  { label: 'Tank Options', sub: 'Adjust tank settings', onClick: uiClick },
  { label: 'Gameplay Options', sub: 'Adjust gameplay settings', onClick: uiClick },
  { label: 'Graphics Options', sub: 'Adjust graphics settings', onClick: uiClick },
  { label: 'Audio Options', sub: 'In game razzle dazzle soundfecta', onClick: uiClick },
  { label: 'Game Content', sub: 'Enable specific weapons and landscapes', onClick: uiClick },
  { label: 'Customize Controls', sub: 'Define custom buttons for game actions', onClick: uiClick },
  { label: 'Customize Players', sub: 'Define custom names and colors (quits current game)', onClick: uiClick },
];

function SettingsItem({ entry, onHover }: { entry: Entry; onHover: (s: string) => void }) {
  return (
    <button
      class="settings-item"
      onMouseEnter={() => onHover(entry.sub)}
      onFocus={() => onHover(entry.sub)}
      onMouseLeave={() => onHover('')}
      onBlur={() => onHover('')}
      onClick={entry.onClick}
    >
      <BmpText font="beijing-20-out" text={entry.label} />
    </button>
  );
}

export function Settings() {
  const [sub, setSub] = useState('');
  // Done closes Settings. The retail subtitle is "Return to the main menu"; when we
  // reached Settings from the in-game pause it returns to the game instead, so the
  // hint follows where Done actually goes.
  const done: Entry = {
    label: 'Done',
    sub: settingsOrigin.value === 'pause' ? 'Return to the game' : 'Return to the main menu',
    onClick: closeSettings,
  };
  return (
    <div class="settings-screen">
      <div class="settings-title"><BmpText font="bazouk-28" text="ATOMIC CANNON" /></div>
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
