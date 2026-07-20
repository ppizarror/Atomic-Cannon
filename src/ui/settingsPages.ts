/**
 * Option-page specs for the Settings tree — the widget rows for each category,
 * with their labels + hover tooltips. Each row is a `Widget`: a toggle (ON/OFF), an
 * int/float stepper, an enum cycle, or a nav row.
 *
 * Values bind two ways. Audio and Difficulty drive live subsystems, so their rows
 * read/write CAudio / the controller directly (one source of truth). Everything else
 * is a remembered preference in `settingsStore`. A row's game effect is wired where
 * possible; the rest are persisted UI whose hooks land as the matching
 * systems come online.
 */
import {getVal, setVal} from './settingsStore';
import {game, openSettingsPage, uiClick} from './store';
import {applyGameSettings} from './applySettings';

export type WidgetKind = 'toggle' | 'stepper' | 'enum' | 'nav';

export interface Widget {
  label: string;
  /** Hover subtitle (the option's description). */
  tip: string;
  kind: WidgetKind;
  get: () => number; // current value (enum index / raw stepper / 0-1 toggle)
  set?: (v: number) => void;
  options?: string[]; // enum labels
  min?: number;
  max?: number;
  step?: number;
  fmt?: (v: number) => string; // stepper
  onClick?: () => void; // nav
}

export interface PageSpec {
  id: string;
  /** Page header desc — shown as the bottom subtitle when no row is hovered. */
  header: string;
  rows: Widget[];
}

// ── enum option pools, in the game's own index-0 (value = min) first order. ──
const DIFFICULTY = [
  '1. Easiest',
  '2. Very Easy',
  '3. Easy',
  '4. Moderate',
  '5. Fun',
  '6. Challenging',
  '7. Hard',
  '8. Very Hard',
  '9. Mastery',
  '10. Elite',
];
const CHANGE_WIND = ['Per game', 'After round', 'After shot', 'Anytime'];
const LAND_TYPE = ['Flat', 'Hill', 'Gulley', 'Plateau', 'Slope', 'Random'];
const PLAYBACK_RATE = ['8000', '11025', '16000', '22050', '32000', '44100'];
const WIND = ['Disabled', 'Low', 'Medium', 'High'];
const KICKBACK = ['Off', 'Low', 'Normal', 'High'];
const PLAYER_SIZE = ['Small', 'Normal', 'Large'];
const EXPLOSION_SIZE = ['Small', 'Normal', 'Large', 'Massive'];
const DETAIL = ['Old School', 'Simple', 'High', 'Wargame'];
const BUY_TIME = ['Anytime', 'Round', 'Start', 'Automatic'];
// The web canvas has no enumerable display modes, so Resolution is presented as the
// common sizes formatted "%dx%dx%d %dHz", a remembered (cosmetic) preference.
const RESOLUTION = [
  '800x600x32 60Hz',
  '1024x768x32 60Hz',
  '1280x1024x32 60Hz',
  '1920x1080x32 60Hz',
];

const pct = (v: number) => `${v}%`;

// ── stored-preference widget builders ────────────────────────────────────────
// Every stored change persists AND re-applies live, so wired options (difficulty,
// wind, variance, …) take effect immediately and start-time ones are ready for the
// next game.
const bind = (id: string, dflt: number) => ({
  get: () => getVal(id, dflt),
  set: (v: number) => {
    setVal(id, v);
    applyGameSettings(game());
  },
});
const toggle = (label: string, tip: string, id: string, dflt: number): Widget => ({
  label,
  tip,
  kind: 'toggle',
  ...bind(id, dflt),
});
const enumW = (
  label: string,
  tip: string,
  id: string,
  dflt: number,
  options: string[],
): Widget => ({label, tip, kind: 'enum', options, ...bind(id, dflt)});
const stepper = (
  label: string,
  tip: string,
  id: string,
  dflt: number,
  min: number,
  max: number,
  step: number,
  fmt?: (v: number) => string,
): Widget => ({label, tip, kind: 'stepper', min, max, step, fmt, ...bind(id, dflt)});

// ── pages ────────────────────────────────────────────────────────────────────
function economyRows(): Widget[] {
  return [
    enumW(
      'Buy Time',
      'When players are allowed to buy, set to automatic for randomly assigned weapons',
      'eco.buyTime',
      0,
      BUY_TIME,
    ),
    stepper(
      'Credit Start',
      'Credits given to each player at match start (default 3000)',
      'eco.creditStart',
      3000,
      0,
      20000,
      500,
    ),
    stepper(
      'Credit Round',
      'Credits given to each player each round (default 1000)',
      'eco.creditRound',
      1000,
      0,
      10000,
      250,
    ),
    stepper(
      'Credit Turn',
      'Credits given to each player per turn (default 0)',
      'eco.creditTurn',
      0,
      0,
      5000,
      100,
    ),
    stepper(
      'Credit Kill',
      'Credits given to each player per kill (default 500)',
      'eco.creditKill',
      500,
      0,
      5000,
      100,
    ),
    stepper(
      'Credit Damage',
      'Credits given to each player per damage done (default 1)',
      'eco.creditDamage',
      1,
      0,
      100,
      1,
    ),
    stepper(
      'Sell Back Rate',
      'Rate at which weapons are sold back to depot (default 50%)',
      'eco.sellBack',
      50,
      0,
      100,
      5,
      pct,
    ),
  ];
}

function tankRows(): Widget[] {
  return [
    enumW('Kickback', 'How much explosions move the tanks.', 'tank.kickback', 2, KICKBACK),
    enumW('Player Size', 'How big the tanks are.', 'tank.size', 1, PLAYER_SIZE),
    toggle('Relative Turrets', 'Aiming it relative to the tank', 'tank.relTurrets', 0),
    toggle('Bury Tanks', 'Tanks can be underground', 'tank.bury', 0),
    stepper(
      'Power Scale',
      'This affects how far a shot will go based on power',
      'tank.powerScale',
      100,
      10,
      300,
      10,
      pct,
    ),
    stepper(
      'Hitpoints',
      'Number of points tank starts with',
      'tank.hitpoints',
      1000,
      100,
      5000,
      100,
    ),
    toggle('Chatter', 'Tanks talk to each other', 'tank.chatter', 1),
    toggle('Colorize Team', 'Tanks are team color', 'tank.colorize', 1),
  ];
}

function gameplayRows(): Widget[] {
  return [
    stepper('Battles', 'How many battles per Deathmatch', 'gp.battles', 5, 1, 50, 1),
    stepper('Rounds', 'How many rounds in a Point game', 'gp.rounds', 10, 1, 100, 1),
    // Difficulty is a stored preference (persisted + applied via applyGameSettings →
    // controller.setDifficulty); index 0..9 maps to AI level 1..10.
    enumW('Difficulty', 'How badly the computer will dominate you', 'gp.difficulty', 4, DIFFICULTY),
    enumW('Wind', 'How the wind affects the trajectories', 'gp.wind', 2, WIND),
    enumW(
      'Change Wind',
      'Defines when the wind changes direction',
      'gp.changeWind',
      0,
      CHANGE_WIND,
    ),
    enumW('Explosion Size', 'How big the explosions are.', 'gp.explosionSize', 1, EXPLOSION_SIZE),
    toggle('Variance', 'All weapons have a different random variance when shot', 'gp.variance', 1),
    toggle('Utility Turn', 'If a utility item use counts as turn', 'gp.utilTurn', 0),
    toggle('Randomize Turns', 'Randomly assings the turn order each battle', 'gp.randTurns', 0),
    stepper('Crates', 'Chance to drop a crate each round', 'gp.crates', 20, 0, 100, 5, pct),
    stepper(
      'Update Scale',
      'The speed at which the game is animated (default 10)',
      'gp.updateScale',
      10,
      1,
      30,
      1,
    ),
    toggle('Right Click Fires', 'If you are accidentally firing disable this', 'gp.rcFires', 1),
  ];
}

function graphicsRows(): Widget[] {
  return [
    enumW('Resolution', 'Window size or monitor size (requires restart)', 'gfx.res', 1, RESOLUTION),
    toggle(
      'Full Screen',
      'Toggle the game between full screen and windowed modes',
      'gfx.fullscreen',
      0,
    ),
    toggle('Tracking', 'Draws a notch for off screen shots', 'gfx.tracking', 1),
    toggle('Draw Smoke', 'Draws smoking plumes on ground', 'gfx.smoke', 1),
    enumW('Detail', 'Lower detail for smoother gameplay', 'gfx.detail', 2, DETAIL),
    toggle('High Contrast', 'Outlines objects with white', 'gfx.highContrast', 0),
    enumW('Land Type', 'Select different landscapes', 'gfx.landType', 5, LAND_TYPE),
    toggle('Show AI Stats', "Show the computer's stats", 'gfx.aiStats', 0),
    toggle('Show Team Color', 'Display each tanks name and team color', 'gfx.teamColor', 1),
    toggle('Small Buy Fonts', 'Use a smaller font on the buy menu', 'gfx.smallBuy', 0),
    toggle('Power Save', 'The game idles to lower power usage', 'gfx.powerSave', 0),
    {
      label: 'More Graphics Options',
      tip: 'Adjust graphics settings',
      kind: 'nav',
      get: () => 0,
      onClick: () => openSettingsPage('graphics2'),
    },
  ];
}

function graphics2Rows(): Widget[] {
  return [
    toggle('Show Turn', 'Display an arrow when its your turn', 'gfx.showTurn', 1),
    toggle('Show Blast Circles', 'Display bounds of explosions', 'gfx.blastCircles', 0),
    toggle('Show Points', 'Display damage points for each shot', 'gfx.showPoints', 1),
    toggle('Show Power', 'Display power bars for each tank', 'gfx.showPower', 1),
    toggle('Show Tank Stats', 'Display stats of each tank', 'gfx.tankStats', 0),
    toggle('Auto Scroll', 'Automatically scrolls during game events', 'gfx.autoScroll', 1),
    toggle('Show Last Aim', 'Show last power and angle position', 'gfx.lastAim', 1),
    toggle('Explosion Waves', 'A very cool refractive wave effect for nukes', 'gfx.expWaves', 1),
    toggle('Show Framerate', 'Display frames rendered per second', 'gfx.framerate', 0),
    toggle('Demo Mode', 'Game automatically plays itself', 'gfx.demo', 0),
  ];
}

function audioRows(): Widget[] {
  const a = game().getAudio();
  return [
    {
      label: 'Sound',
      tip: 'Toggle sound effects on and off',
      kind: 'toggle',
      get: () => (a?.isSfxEnabled() ? 1 : 0),
      set: (v: number) => a?.setSfxEnabled(!!v),
    },
    {
      label: 'Music',
      tip: 'Toggle music on and off',
      kind: 'toggle',
      get: () => (a?.isMusicEnabled() ? 1 : 0),
      set: (v: number) => a?.setMusicEnabled(!!v),
    },
    {
      // CAudio volumes are already 0..100 (percent) — pass through, don't rescale.
      label: 'Sound Volume',
      tip: 'Sound effects volume',
      kind: 'stepper',
      min: 0,
      max: 100,
      step: 10,
      fmt: pct,
      get: () => Math.round(a?.getSfxVolume() ?? 100),
      set: (v: number) => a?.setSfxVolume(v),
    },
    {
      label: 'Music Volume',
      tip: 'Music soundtrack volume',
      kind: 'stepper',
      min: 0,
      max: 100,
      step: 10,
      fmt: pct,
      get: () => Math.round(a?.getMusicVolume() ?? 100),
      set: (v: number) => a?.setMusicVolume(v),
    },
    toggle('Stereo', 'Enable stereo sound', 'aud.stereo', 1),
    enumW('Playback Rate', 'Sound playback sampling frequency rate', 'aud.rate', 5, PLAYBACK_RATE),
  ];
}

function contentRows(): Widget[] {
  // Weapons / Landscapes open dedicated enable-list editors (over the steel plate);
  // those screens aren't built yet, so the rows click but don't navigate.
  return [
    {
      label: 'Weapons',
      tip: 'Enable only the weapons you want (quits current game)',
      kind: 'nav',
      get: () => 0,
      onClick: uiClick,
    },
    {
      label: 'Landscapes',
      tip: 'Enable only the landscapes you want (quits current game)',
      kind: 'nav',
      get: () => 0,
      onClick: uiClick,
    },
  ];
}

export function getSettingsPage(id: string): PageSpec | null {
  switch (id) {
    case 'economy':
      return {id, header: 'Adjust economic settings', rows: economyRows()};
    case 'tank':
      return {id, header: 'Adjust tank settings', rows: tankRows()};
    case 'gameplay':
      return {id, header: 'Adjust gameplay settings', rows: gameplayRows()};
    case 'graphics':
      return {id, header: 'Adjust graphics settings', rows: graphicsRows()};
    case 'graphics2':
      return {id, header: 'Adjust graphics settings', rows: graphics2Rows()};
    case 'audio':
      return {id, header: 'Adjust sound and music settings', rows: audioRows()};
    case 'content':
      return {id, header: 'Enable specific weapons and landscapes', rows: contentRows()};
    default:
      return null;
  }
}
