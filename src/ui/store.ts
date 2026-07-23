/**
 * UI store — signals mirroring the live game state, pumped once per frame.
 *
 * Preact reads these signals; the game controller never touches the DOM. Screens
 * (menu / settings / depot) switch on `screen`.
 */
import {signal} from '@preact/signals';
import {strings, fmt} from '../i18n';
import {
  EGameState,
  type CGameController,
  type WarStandings,
  type ActiveTaunt,
} from '../game/CGameController';
import type {WeaponDef} from '../core/CWeapon';
import {applyGameSettings} from './applySettings';
import {setup, playersOf} from './setupStore';
import {submitBattleHeroes, recordBattleOutcome} from './highscoresStore';
import {wrapIndex} from '../math/num';
import {knockoutWhere} from '../util/canvas';

export type Screen = 'menu' | 'battle' | 'settings' | 'about' | 'setup' | 'highscores';

export const screen = signal<Screen>('battle');

// Weapons Depot overlay — buy/sell screen shown above the battle HUD.
export const showDepot = signal(false);
// Economy state, mirrored from the controller on demand (not every frame — it only
// changes on buy/sell). `owned[i]` = rounds for weapon i (Infinity = unlimited).
export const credits = signal(0);
export const ownedCounts = signal<number[]>([]);
export const mapName = signal('');

/** Pull the current credits + inventory into the signals (after a buy/sell/open). */
function refreshEconomy(): void {
  const c = controller;
  if (!c) return;
  credits.value = Math.floor(c.getCredits());
  ownedCounts.value = c.getOwnedCounts();
  mapName.value = c.getMapName();
}

/** Open/close the depot (refreshes the economy snapshot on open). Gated by Economy → Buy
 *  Time: no-op when the current player isn't allowed to buy right now. Reads the live
 *  controller (not the once-per-frame `canBuyNow` signal, which may be stale at open time). */
export function openDepot(): void {
  if (controller && !controller.canOpenDepot()) return;
  refreshEconomy();
  showDepot.value = true;
  uiClick();
}

export function closeDepot(): void {
  showDepot.value = false;
  uiClick();
}

// Pause menu — an overlay over the frozen battle (Resume / Settings / Quit).
export const showPause = signal(false);

/** Open the pause menu and freeze the sim (ESC during battle). */
export function openPauseMenu(): void {
  if (screen.value !== 'battle') return;
  showDepot.value = false; // never leave the depot open behind the pause menu
  game().setPaused(true);
  paused.value = true;
  showPause.value = true;
  uiClick();
}

/** Resume: close the pause menu and unfreeze the sim. */
export function resumeGame(): void {
  showPause.value = false;
  game().setPaused(false);
  paused.value = false;
  uiClick();
}

// Help overlay — the "?" panel button. Shows a modal control reference. Freeze the
// sim while it's up so the shot-timer doesn't drain behind it.
export const showHelp = signal(false);

/** Open the Help overlay and freeze the sim. */
export function openHelp(): void {
  if (screen.value !== 'battle') return;
  game().setPaused(true);
  paused.value = true;
  showHelp.value = true;
  uiClick();
}

/** Close Help and unfreeze the sim. */
export function closeHelp(): void {
  showHelp.value = false;
  game().setPaused(false);
  paused.value = false;
  uiClick();
}

// Where the Settings screen returns to when done — the pause menu or the main menu.
export const settingsOrigin = signal<'pause' | 'menu'>('pause');

// Which Settings page is showing: 'root' (the category list) or a category id
// ('economy' | 'tank' | 'gameplay' | 'graphics' | 'graphics2' | 'audio' | 'content').
export const settingsPage = signal<string>('root');

/** Open the Settings screen, remembering where to return (pause vs main menu). */
export function openSettings(from: 'pause' | 'menu'): void {
  settingsOrigin.value = from;
  settingsPage.value = 'root';
  showPause.value = false;
  screen.value = 'settings';
  uiClick();
}

/** Enter a category's option page (from the Settings root). */
export function openSettingsPage(id: string): void {
  settingsPage.value = id;
  uiClick();
}

/** Leave an option page back to the Settings root ("Return to the settings menu"). */
export function settingsPageBack(): void {
  settingsPage.value = 'root';
  uiClick();
}

/** Leave Settings, returning to whichever menu opened it (battle stays frozen). */
export function closeSettings(): void {
  if (settingsOrigin.value === 'pause') {
    screen.value = 'battle';
    showPause.value = true;
  } else {
    screen.value = 'menu';
  }
  uiClick();
}

/** Enter the main menu: freeze the battle behind it and play menu music. We freeze
 * the render loop via the `paused` signal (which skips the sim update) rather than
 * `setPaused`, because `setPaused` SUSPENDS the AudioContext — that would gag the
 * menu music. `setPaused(false)` clears any prior game-pause suspend first. */
export function goToMenu(): void {
  showPause.value = false;
  screen.value = 'menu';
  game().setPaused(false);
  paused.value = true;
  game().getAudio()?.menuMusic();
}

/** A match needs at least two teams (humans + computers) to have an opponent. */
export const MIN_PLAYERS = 2;

/** Common launch path: honour the saved options, set the counts, enter battle. */
function enterBattle(players: number, humans: number, tanksPerTeam: number): void {
  applyGameSettings(game()); // honour the saved options for this match
  game().setHumanCount(humans);
  game().setTanksPerTeam(tanksPerTeam);
  game().startGame(players); // also starts the battle music
  screen.value = 'battle';
  game().setPaused(false);
  paused.value = false;
}

/** Start a battle from the current (persisted) Play setup — the Start Game button.
 *  No-op when there are fewer than two players (the Play screen blocks it there too). */
export function startBattle(): void {
  const s = setup.value;
  if (playersOf(s) < MIN_PLAYERS) return;
  uiClick();
  enterBattle(playersOf(s), s.humans, s.tanksPerTeam);
}

/** Play → open the game-setup screen (the "Play" config page). */
export function openPlaySetup(): void {
  screen.value = 'setup';
  uiClick();
}

/** Quick Play → start immediately with the last-used setup. */
export function quickPlay(): void {
  startBattle();
}

/** A plain 2-player battle (dev URL affordances + boot) — does not touch the setup. */
export function playNewGame(): void {
  uiClick();
  enterBattle(2, 1, 1);
}

/** Main menu → About, and back. */
export function openAbout(): void {
  screen.value = 'about';
  uiClick();
}

/** Main menu → High Scores (the Battle Heroes hall of fame). */
export function openHighScores(): void {
  screen.value = 'highscores';
  uiClick();
}
export function backToMenu(): void {
  screen.value = 'menu';
  uiClick();
}

/** Quit the current battle back to the main menu (UI). */
export function quitToMenu(): void {
  goToMenu();
  uiClick();
}

/** Depot actions — mutate the controller's economy, then re-sync + click. */
export function depotBuy(i: number): void {
  if (controller?.buyWeapon(i)) {
    refreshEconomy();
    uiClick();
  }
}

export function depotSell(i: number): void {
  if (controller?.sellWeapon(i)) {
    refreshEconomy();
    uiClick();
  }
}

export function depotAutoBuy(): void {
  controller?.autoBuyWeapons();
  refreshEconomy();
  uiClick();
}

// Framerate counter (More Graphics Options → Show Framerate): the toggle + the live smoothed
// value, published from the game loop.
export const showFramerate = signal(false);
export const fps = signal(0);
// Max framerate cap (More Graphics → Max Framerate): the ticker's maxFPS (0 = uncapped).
// The game loop applies it to the Pixi ticker.
export const maxFps = signal(0);

// Frame counter (dev: ?frame=1): the toggle + a monotonic count of ticker frames since the
// flag was enabled, published every frame from the game loop. Sits just below the FPS readout.
export const showFrameCount = signal(false);
export const frameCount = signal(0);

// Active taunt speech bubbles (Chatter), projected to screen-fraction positions and
// pumped each frame; the TauntLayer overlay renders one <Tooltip> per entry.
export const tauntBubbles = signal<ActiveTaunt[]>([]);

// Jet flight (extType 17): live while the human is airborne, with remaining fuel.
export const flying = signal(false);
export const jetFuel = signal(0);

// Live HUD values (updated every frame from the controller).
export const power = signal(500);
export const angle = signal(45);
export const wind = signal(0);
export const weaponIndex = signal(0);
export const playerName = signal('');
export const teamColor = signal('#ff4444');
export const life = signal(1000);
export const maxLife = signal(1000);
export const shield = signal(0);
export const canFire = signal(false);
// Whether the depot may be opened right now (Economy → Buy Time). Drives the depot button.
export const canBuyNow = signal(false);

// Extra per-tank / world readouts for the side LCDs (updated each frame; number
// signals only re-notify on an actual change, so the bitmap text stays cheap).
export const teamId = signal(1);
export const armor = signal(0); // Armor %  (physical damage reduction)
export const hazmat = signal(0); // Hazmat % (radiation resistance)
export const posX = signal(0);
export const posY = signal(0);
// Wind velocity + acceleration, both quantised to 0.01 so they only publish when
// the displayed "Vel/Acc %.02f %.02f" actually moves.
export const windVelX = signal(0),
  windVelY = signal(0);
export const windAccX = signal(0),
  windAccY = signal(0);
export const canMoveNow = signal(false);
// True whenever the HUD controls should read as "held": the game is paused, or
// it's not the human's live turn (shot in flight, explosion, a bot playing). The
// panel greys out and stops responding while this is set.
export const blocked = signal(true);
export const winner = signal('');
// Between-battles "winning the war" standings (null during normal play).
export const warStandings = signal<WarStandings | null>(null);

/** Advance from the standings screen: the next battle, or exit to the menu when the
 *  war is over (click anywhere on the standings). */
export function advanceWar(): void {
  const s = warStandings.value;
  if (!s) return;
  warStandings.value = null;
  uiClick();
  game().clearTaunts(); // drop the victor's bubble before leaving the standings
  if (s.warOver) {
    // War over: record every team on the Battle Heroes boards before leaving.
    submitBattleHeroes(game().getBattleHeroes());
    goToMenu();
  } else game().nextBattle();
}
export const screenFlash = signal(0); // full-viewport white-out intensity (0..1)
export const screenFlashColor = signal('#ffffff'); // flash tint (the bomb's colour)

// HUD shockwave ripple: the WebGL wave filter can't reach the DOM HUD, so we mirror
// it with a DOM (SVG-displacement) pulse. `hudWave` is a nonce bumped per impact;
// `hudWaveStrength` scales the ripple (beam ~1, nuke ~2.6+).
export const hudWave = signal(0);
export const hudWaveStrength = signal(1);
export function triggerHudWave(strength: number): void {
  hudWaveStrength.value = strength;
  hudWave.value = hudWave.value + 1;
}
// True while the sim is paused (P key). DOM FX (the HUD ripple) freeze on it so a
// paused frame holds the effect for inspection, like the frozen game wave.
export const paused = signal(false);

export const weapons = signal<WeaponDef[]>([]);

// Shot-time bar below FIRE: fraction of turn time remaining (1 = full) + its
// green→yellow→red colour, or null when there's no active countdown. Republished
// only when the quantised width or colour changes, so the bar animates without
// churning every frame.
export const turnTimer = signal<{frac: number; color: string} | null>(null);

// Top-left status overlay: per-tank life lines (team-coloured) + the battle/shot
// line — "%s: %d%% life" and "Battle %d of %d - Shot %d".
export const battleStatus = signal<{
  lines: {text: string; color: string; dead: boolean; active: boolean}[];
  battle: string;
}>({lines: [], battle: ''});

// Fraction of view width the top-left status text is pushed right to clear the
// minimap (0 = no minimap → default left inset).
export const statusLeftFrac = signal(0);

// Power/angle ranges (UI units). Angle is a full circle measured CCW from
// horizontal-right and WRAPS at the ends: 0 = right, 90 = up, 180 = left,
// 270 = straight down, 315 = down-right. Stepping past 359 wraps to 0 (and 0 → 359),
// so below-horizon aim reads 181..359 rather than going negative.
export const POWER_MIN = 10,
  POWER_MAX = 1000;

/** Fold any angle (deg) into the wrapping 0..359 range the HUD uses. */
export const wrapAngle = (deg: number): number => wrapIndex(deg, 360);

let controller: CGameController | null = null;

export function setController(c: CGameController): void {
  controller = c;
  weapons.value = c.getWeaponDefs() as WeaponDef[];
}

export function game(): CGameController {
  if (!controller) throw new Error('controller not set');
  return controller;
}

/** UI button click (click.wav) — used by menu-style HUD controls. */
export function uiClick(): void {
  controller?.getAudio()?.uiClick();
}

/** Copy the current game state into the signals (called each frame). */
export function syncHud(): void {
  const c = controller;
  if (!c) return;
  power.value = Math.round(c.getPower());
  angle.value = Math.round(c.getAngle());
  wind.value = c.getWindValue();
  weaponIndex.value = c.getCurrentWeaponIndex();
  // The selectable list can change with the turn (the human's control-weapon
  // lock vs. a bot's full arsenal); refresh only when it actually flips so the
  // list doesn't re-render every frame.
  const defs = c.getWeaponDefs() as WeaponDef[];
  if (defs.length !== weapons.value.length || defs[0] !== weapons.value[0]) {
    weapons.value = defs;
  }
  playerName.value = c.getCurrentPlayerName();
  teamColor.value = c.getCurrentTeamColor();
  const tank = c.getCurrentTank();
  const h = tank.getHealth();
  life.value = Math.max(0, Math.round(h.nLife));
  maxLife.value = Math.round(tank.getMaxLife()); // Hitpoints (Settings → Tank)
  shield.value = Math.max(0, Math.round(h.nShield));
  // Side-LCD tank/world readouts (each signal only re-notifies on a real change).
  teamId.value = tank.getTeamId();
  armor.value = Math.round(h.nArmor);
  hazmat.value = Math.round(h.nHazmat);
  const pos = tank.getPosition();
  posX.value = Math.round(pos.x);
  posY.value = Math.round(pos.y);
  credits.value = Math.floor(c.getCredits());
  const wv = c.getWindVec(),
    wa = c.getWindAccel();
  windVelX.value = Math.round(wv.x * 100) / 100;
  windVelY.value = Math.round(wv.y * 100) / 100;
  windAccX.value = Math.round(wa.x * 100) / 100;
  windAccY.value = Math.round(wa.y * 100) / 100;
  canMoveNow.value = c.getCurrentTankCanMove();
  canFire.value = c.isPlayerTurn();
  canBuyNow.value = c.canOpenDepot();
  flying.value = c.isFlying();
  jetFuel.value = c.getJetFuel();
  // Held when paused or when it isn't the human's live turn (see `blocked`).
  blocked.value = c.isPaused() || !c.isPlayerTurn();
  winner.value = c.getWinnerName();
  // Between-battles standings: compute once on entering BattleEnd, clear on leaving.
  const atBattleEnd = c.getState() === EGameState.BattleEnd;
  if (atBattleEnd && !warStandings.value) warStandings.value = c.getWarStandings();
  else if (!atBattleEnd && warStandings.value) warStandings.value = null;
  // Battle Heroes won/lost tally: advance once per battle end (the controller hands
  // the outcome over exactly once, so polling here is safe).
  const outcome = c.takeBattleOutcome();
  if (outcome) recordBattleOutcome(outcome === 'won');
  screenFlash.value = c.getScreenFlash();
  screenFlashColor.value = c.getScreenFlashColor();

  // Taunt bubbles: re-publish only when there's something to show or clear, so the
  // overlay doesn't churn every idle frame (the common case is an empty list).
  const taunts = c.getActiveTaunts();
  if (taunts.length || tauntBubbles.value.length) tauntBubbles.value = taunts;

  // Top-left status text — only re-publish when it actually changes so the
  // bitmap-font lines don't re-render every frame.
  const g = strings.value.game;
  const lines = c.getTankStatuses().map(s => ({
    text: fmt(g.statusLife, {name: s.name, pct: s.lifePct}),
    color: s.color,
    dead: !s.alive,
    active: s.active,
  }));
  const battle = c.getStatusLine(); // "Round N of M" (Rounds) or "Battle N of M - Shot X"
  const sig = lines.map(l => l.text + l.color + l.dead + l.active).join('|') + '#' + battle;
  if (sig !== lastBattleSig) {
    lastBattleSig = sig;
    battleStatus.value = {lines, battle};
  }
  // Shift the status text clear of the minimap (large maps only).
  const slf = c.getMinimapRightFrac();
  if (slf !== statusLeftFrac.value) statusLeftFrac.value = slf;

  // Shot-time bar — republish only when the drawn width (quantised to whole
  // percent) or colour flips, so the drain animates smoothly but cheaply.
  const t = c.getTurnTimer();
  const tSig = t ? `${Math.round(t.frac * 100)}|${t.color}` : '';
  if (tSig !== lastTimerSig) {
    lastTimerSig = tSig;
    turnTimer.value = t;
  }
}

let lastBattleSig = '';
let lastTimerSig = '';

// --- generic UI bitmap loader (colour-key → transparent), cached as a data URL ---
const bmpCache = new Map<string, Promise<string | null>>();

// Colour-key predicates. The zeon dialog art keys grey (64,64,64) as its outside
// (so the rounded corners cut out), while its arrows key pure green (0,255,0).
export type BmpKey = 'magenta' | 'green' | 'grey' | 'greyblack' | 'black';
const isGrey = (p: Uint8ClampedArray, i: number) =>
  Math.abs(p[i] - 64) < 26 && Math.abs(p[i + 1] - 64) < 26 && Math.abs(p[i + 2] - 64) < 26;
const KEYERS: Record<BmpKey, (p: Uint8ClampedArray, i: number) => boolean> = {
  magenta: (p, i) => p[i] > 200 && p[i + 1] < 70 && p[i + 2] > 200,
  green: (p, i) => p[i] < 70 && p[i + 1] > 200 && p[i + 2] < 70,
  grey: isGrey,
  // grey outside + black corner outline both keyed — the zeon dialog with its
  // black rounded-corner border stripped (these tooltips have no black border).
  greyblack: (p, i) => isGrey(p, i) || (p[i] < 40 && p[i + 1] < 40 && p[i + 2] < 40),
  // pure black background only (the Battle Heroes medal badges sit on 0,0,0) — a tight
  // threshold so the medals' own dark edges survive.
  black: (p, i) => p[i] < 24 && p[i + 1] < 24 && p[i + 2] < 24,
};

/** Shared core: load an /assets image, knock out every pixel the `hit` predicate
 *  flags (alpha → 0), and cache the resulting data URL under `cacheKey`. */
function loadColorKeyedBmp(
  cache: Map<string, Promise<string | null>>,
  cacheKey: string,
  src: string,
  hit: (p: Uint8ClampedArray, i: number) => boolean,
): Promise<string | null> {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const p = new Promise<string | null>(resolve => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const g = cv.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const im = g.getImageData(0, 0, cv.width, cv.height);
      const px = im.data;
      knockoutWhere(px, hit);
      g.putImageData(im, 0, 0);
      resolve(cv.toDataURL());
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  cache.set(cacheKey, p);
  return p;
}

/** Load an /assets BMP, knock out the `key` colour as transparency, cache it.
 * Used for the depot's colour-keyed UI art (sort arrows, tooltip dialog/pointer). */
export function loadUiBmp(path: string, key: BmpKey = 'magenta'): Promise<string | null> {
  return loadColorKeyedBmp(
    bmpCache,
    `${path}#${key}`,
    encodeURI(path.startsWith('/') ? path : `/assets/${path}`),
    KEYERS[key],
  );
}

// --- weapon icons: load the BMP, knock out magenta, cache as a data URL -------
const iconCache = new Map<string, Promise<string | null>>();

/** Load a weapon icon at the given native pixel size (12 | 16 | 32). Only magenta
 *  keys out — the grey (128,128,128) tile is the icon's intended background. Icon
 *  files are lowercase; Vite serves public assets case-sensitively. */
export function loadWeaponIcon(name: string, size: 12 | 16 | 32 = 32): Promise<string | null> {
  return loadColorKeyedBmp(
    iconCache,
    `${size}/${name}`,
    encodeURI(`/assets/icons/${size}x${size}/${name.toLowerCase()}.bmp`),
    KEYERS.magenta,
  );
}
