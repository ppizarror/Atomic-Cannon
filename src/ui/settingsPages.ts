/**
 * Option-page specs for the Settings tree — the widget rows for each category, with their
 * labels + hover tooltips. Each row is a `Widget`: a toggle (ON/OFF), an int/float stepper,
 * an enum cycle, or a nav row.
 *
 * Stored rows get their id's DEFAULT and enum LABELS from `settingsCatalog` (SETTINGS) — the
 * builders below only carry presentation (label / tip / stepper range). Audio rows are the
 * exception: they read/write CAudio directly (one live source of truth), so they're spelled
 * out by hand. A row's game effect is wired via `applyGameSettings`; the rest are persisted
 * UI whose hooks land as the matching systems come online.
 */
import {getVal, setVal} from './settingsStore';
import {SETTINGS, type SettingId} from './settingsCatalog';
import {game, openSettingsPage} from './store';
import {applyGameSettings} from './applySettings';

export type WidgetKind = 'toggle' | 'stepper' | 'enum' | 'nav';

export interface Widget {
  label: string;
  /** Hover subtitle (the option's description). */
  tip: string;
  kind: WidgetKind;
  get: () => number; // current value (enum index / raw stepper / 0-1 toggle)
  set?: (v: number) => void;
  options?: readonly string[]; // enum labels (from the catalog)
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

const pct = (v: number) => `${v}%`;

// ── stored-preference widget builders ────────────────────────────────────────
// Default + enum labels come from SETTINGS[id]; only presentation is passed in. Every
// stored change persists AND re-applies live, so wired options (difficulty, wind, variance,
// …) take effect immediately and start-time ones are ready for the next game.
export const bind = (id: SettingId) => ({
  get: () => getVal(id),
  set: (v: number) => {
    setVal(id, v);
    applyGameSettings(game());
  },
});
const toggle = (label: string, tip: string, id: SettingId): Widget => ({
  label,
  tip,
  kind: 'toggle',
  ...bind(id),
});
export const enumW = (label: string, tip: string, id: SettingId): Widget => ({
  label,
  tip,
  kind: 'enum',
  options: SETTINGS[id].options,
  ...bind(id),
});
export const stepper = (
  label: string,
  tip: string,
  id: SettingId,
  min: number,
  max: number,
  step: number,
  fmt?: (v: number) => string,
): Widget => ({label, tip, kind: 'stepper', min, max, step, fmt, ...bind(id)});

// ── pages ────────────────────────────────────────────────────────────────────
function economyRows(): Widget[] {
  return [
    enumW(
      'Buy Time',
      'When players are allowed to buy, set to automatic for randomly assigned weapons',
      'eco.buyTime',
    ),
    stepper(
      'Credit Start',
      'Credits given to each player at match start (default 3000)',
      'eco.creditStart',
      0,
      20000,
      500,
    ),
    stepper(
      'Credit Round',
      'Credits given to each player each round (default 1000)',
      'eco.creditRound',
      0,
      10000,
      250,
    ),
    stepper(
      'Credit Turn',
      'Credits given to each player per turn (default 0)',
      'eco.creditTurn',
      0,
      5000,
      100,
    ),
    stepper(
      'Credit Kill',
      'Credits given to each player per kill (default 500)',
      'eco.creditKill',
      0,
      5000,
      100,
    ),
    stepper(
      'Credit Damage',
      'Credits given to each player per damage done (default 1)',
      'eco.creditDamage',
      0,
      100,
      1,
    ),
    stepper(
      'Sell Back Rate',
      'Rate at which weapons are sold back to depot (default 50%)',
      'eco.sellBack',
      0,
      100,
      5,
      pct,
    ),
  ];
}

function tankRows(): Widget[] {
  return [
    enumW('Kickback', 'How much explosions move the tanks.', 'tank.kickback'),
    enumW('Player Size', 'How big the tanks are.', 'tank.size'),
    toggle('Relative Turrets', 'Aiming it relative to the tank', 'tank.relTurrets'),
    toggle('Bury Tanks', 'Tanks can be underground', 'tank.bury'),
    stepper(
      'Power Scale',
      'This affects how far a shot will go based on power',
      'tank.powerScale',
      10,
      300,
      10,
      pct,
    ),
    stepper('Hitpoints', 'Number of points tank starts with', 'tank.hitpoints', 100, 5000, 100),
    toggle('Chatter', 'Tanks talk to each other', 'tank.chatter'),
    toggle('Colorize Team', 'Tanks are team color', 'tank.colorize'),
  ];
}

function gameplayRows(): Widget[] {
  return [
    stepper('Battles', 'How many battles per Deathmatch', 'gp.battles', 1, 50, 1),
    stepper('Rounds', 'How many rounds in a Point game', 'gp.rounds', 1, 50, 1),
    // Difficulty is a stored preference (persisted + applied via applyGameSettings →
    // controller.setDifficulty); index 0..9 maps to AI level 1..10.
    enumW('Difficulty', 'How badly the computer will dominate you', 'gp.difficulty'),
    enumW('Wind', 'How the wind affects the trajectories', 'gp.wind'),
    enumW('Change Wind', 'Defines when the wind changes direction', 'gp.changeWind'),
    enumW('Explosion Size', 'How big the explosions are.', 'gp.explosionSize'),
    toggle('Variance', 'All weapons have a different random variance when shot', 'gp.variance'),
    toggle('Utility Turn', 'If a utility item use counts as turn', 'gp.utilTurn'),
    toggle('Randomize Turns', 'Randomly assings the turn order each battle', 'gp.randTurns'),
    stepper('Crates', 'Chance to drop a crate each round', 'gp.crates', 0, 100, 5, pct),
    stepper(
      'Update Scale',
      'The speed at which the game is animated (default 10)',
      'gp.updateScale',
      1,
      30,
      1,
    ),
    toggle('Right Click Fires', 'If you are accidentally firing disable this', 'gp.rcFires'),
  ];
}

function graphicsRows(): Widget[] {
  return [
    {
      // Real fullscreen via the Fullscreen API; reads the live document state so it
      // stays reactive (leaving fullscreen with Esc flips it back to OFF on its own).
      label: 'Full Screen',
      tip: 'Toggle the game between full screen and windowed modes',
      kind: 'toggle',
      get: () => (typeof document !== 'undefined' && document.fullscreenElement ? 1 : 0),
      set: (v: number) => {
        if (typeof document === 'undefined') return;
        if (v) void document.documentElement.requestFullscreen?.();
        else void document.exitFullscreen?.();
      },
    },
    toggle('Tracking', 'Draws a notch for off screen shots', 'gfx.tracking'),
    toggle('Draw Smoke', 'Draws smoking plumes on ground', 'gfx.smoke'),
    toggle('High Contrast', 'Outlines objects with white', 'gfx.highContrast'),
    enumW('Land Type', 'Select different landscapes', 'gfx.landType'),
    toggle('Show AI Stats', "Show the computer's stats", 'gfx.aiStats'),
    toggle('Show Team Color', 'Display each tanks name and team color', 'gfx.teamColor'),
    toggle('Small Buy Fonts', 'Use a smaller font on the buy menu', 'gfx.smallBuy'),
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
    toggle('Show Turn', 'Display an arrow when its your turn', 'gfx.showTurn'),
    toggle('Show Blast Circles', 'Display bounds of explosions', 'gfx.blastCircles'),
    toggle('Show Points', 'Display damage points for each shot', 'gfx.showPoints'),
    toggle('Show Power', 'Display power bars for each tank', 'gfx.showPower'),
    toggle('Show Tank Stats', 'Display stats of each tank', 'gfx.tankStats'),
    toggle('Auto Scroll', 'Automatically scrolls during game events', 'gfx.autoScroll'),
    toggle('Show Last Aim', 'Show last power and angle position', 'gfx.lastAim'),
    toggle('Explosion Waves', 'A very cool refractive wave effect for nukes', 'gfx.expWaves'),
    enumW('Show Framerate', 'Off, the FPS counter, or FPS + a frame count (Full)', 'gfx.framerate'),
    enumW(
      'Max Framerate',
      'Cap the frame rate to save CPU / battery (No Limit = the display refresh rate)',
      'gfx.fpsCap',
    ),
    toggle('Demo Mode', 'Game automatically plays itself', 'gfx.demo'),
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
    toggle('Stereo', 'Enable stereo sound', 'aud.stereo'),
  ];
}

function contentRows(): Widget[] {
  // Weapons / Landscapes open dedicated enable-list editors (over the steel plate).
  return [
    {
      label: 'Weapons',
      tip: 'Enable only the weapons you want (quits current game)',
      kind: 'nav',
      get: () => 0,
      onClick: () => openSettingsPage('content.weapons'),
    },
    {
      label: 'Landscapes',
      tip: 'Enable only the landscapes you want (quits current game)',
      kind: 'nav',
      get: () => 0,
      onClick: () => openSettingsPage('content.landscapes'),
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
