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
import {postGameStats} from '../net/stats';
import {wrapIndex} from '../math/num';
import {knockoutWhere, makeCanvas2d} from '../util/canvas';

export type Screen =
  'menu' | 'battle' | 'settings' | 'about' | 'manual' | 'setup' | 'highscores' | 'network';

export const screen = signal<Screen>('battle');

// Loading screen: true while a freshly-launched match loads its landscape textures. A
// menu-styled overlay (title backdrop + animated dots) covers the still-untextured world
// and the battle is revealed only once assetsReady() resolves — so the player never sees
// the gradient-sky / untextured-terrain fallback. See enterBattle + LoadingScreen.
export const loading = signal(false);
// Generation counter: each launch bumps it so a stale assetsReady() resolution (e.g. a rapid
// second Play) can't reveal a superseded match.
let launchToken = 0;

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

/** Freeze the battle sim behind a modal overlay (depot / pause / help): halt the shot-timer AND
 *  suspend the gameplay-SFX audio context (in-flight effects/loops freeze and resume in sync; music
 *  and UI sounds keep playing). Paired with {@link unfreezeSim}. (goToMenu deliberately does NOT use
 *  these — it freezes only the render loop; see there.) */
function freezeSim(): void {
  game().setPaused(true);
  paused.value = true;
}

/** Resume the sim after a {@link freezeSim}: run update() again and un-suspend gameplay audio. */
function unfreezeSim(): void {
  game().setPaused(false);
  paused.value = false;
}

/** Open/close the depot (refreshes the economy snapshot on open). Gated by Economy → Buy
 *  Time: no-op when the current player isn't allowed to buy right now. Reads the live
 *  controller (not the once-per-frame `canBuyNow` signal, which may be stale at open time). */
export function openDepot(): void {
  if (controller && !controller.canOpenDepot()) return;
  refreshEconomy();
  // Freeze the sim while shopping (as Help does) so the shot-timer can't drain — and, more
  // importantly, can't FORFEIT the turn out from under the open depot, which would then leave it
  // buying/selling against whoever's turn it became (credits are per-tank).
  freezeSim();
  showDepot.value = true;
  uiOpen();
  pushRoute();
}

export function closeDepot(): void {
  showDepot.value = false;
  unfreezeSim();
  uiClose();
  popRoute();
}

// Pause menu — an overlay over the frozen battle (Resume / Settings / Quit).
export const showPause = signal(false);

/** Open the pause menu and freeze the sim (ESC during battle). */
export function openPauseMenu(): void {
  if (screen.value !== 'battle') return;
  showDepot.value = false; // never leave the depot open behind the pause menu
  freezeSim();
  showPause.value = true;
  uiOpen();
  pushRoute();
}

/** Resume: close the pause menu and unfreeze the sim. */
export function resumeGame(): void {
  showPause.value = false;
  unfreezeSim();
  uiClose();
  popRoute();
}

// Help overlay — the "?" panel button. Shows a modal control reference. Freeze the
// sim while it's up so the shot-timer doesn't drain behind it.
export const showHelp = signal(false);

/** Open the Help overlay and freeze the sim. */
export function openHelp(): void {
  if (screen.value !== 'battle') return;
  freezeSim();
  showHelp.value = true;
  uiOpen();
  pushRoute();
}

/** Close Help and unfreeze the sim. */
export function closeHelp(): void {
  showHelp.value = false;
  unfreezeSim();
  uiClose();
  popRoute();
}

// Where the Settings screen returns to when done — the pause menu or the main menu.
export const settingsOrigin = signal<'pause' | 'menu'>('pause');

// Which Settings page is showing: 'root' (the category list) or a category id
// ('economy' | 'tank' | 'gameplay' | 'graphics' | 'audio' | 'content'), optionally with a
// '~<n>' suffix for an auto-paginated sub-page (e.g. 'graphics~2' = the 3rd graphics page).
export const settingsPage = signal<string>('root');

/** Open the Settings screen, remembering where to return (pause vs main menu). */
export function openSettings(from: 'pause' | 'menu'): void {
  settingsOrigin.value = from;
  settingsPage.value = 'root';
  showPause.value = false;
  screen.value = 'settings';
  // From the main menu this is a menu navigation (Mechanismus forward); from the
  // in-battle pause menu it's a dialog panel opening over the frozen battle.
  if (from === 'menu') uiMenuForward();
  else uiOpen();
  pushRoute();
}

/** Enter a Settings page. Route-wise: descending into a page pushes; a Back to an ancestor (an
 *  editor returning to its `content` group, or to root) pops; paginating within the same category
 *  rewrites (Done always returns to root, so the `~n` pages aren't a back-stack). */
export function openSettingsPage(id: string): void {
  const prev = settingsPage.value;
  settingsPage.value = id;
  uiClick();
  if (id === parentPage(prev)) popRoute();
  else if (baseOf(id) === baseOf(prev) && id !== prev) replaceRoute();
  else pushRoute();
}

/** Leave an option page back to the Settings root ("Return to the settings menu"). */
export function settingsPageBack(): void {
  settingsPage.value = 'root';
  uiClick();
  popRoute();
}

/** Leave Settings, returning to whichever menu opened it (battle stays frozen). */
export function closeSettings(): void {
  if (settingsOrigin.value === 'pause') {
    screen.value = 'battle';
    showPause.value = true;
    uiClose();
  } else {
    screen.value = 'menu';
    uiMenuBack(); // returning to the main menu — the menu "back" whirr
  }
  popRoute();
}

/** Enter the main menu: freeze the battle behind it and play menu music. We freeze only the RENDER
 * loop via the `paused` signal (which skips the sim update). We call `setPaused(false)` rather than
 * `freezeSim` so the gameplay-SFX context is left RUNNING, not suspended — otherwise an effect
 * frozen when the pause menu opened would stay frozen and then bleed into the NEXT battle when it
 * resumes. Menu music and UI sounds live on the always-on context, so they play regardless. */
export function goToMenu(): void {
  showPause.value = false;
  screen.value = 'menu';
  // Tear the battle DOWN (not just freeze it): isStarted() → false, so the sim/redraw/HUD all
  // short-circuit like the boot title screen — no tanks keep playing and the scene is cleared. Also
  // stops any tank-drive / jet loop.
  game().stopGame();
  game().setPaused(false); // resume the gameplay audio context so the menu music can play
  paused.value = true; // and skip the render-loop sim update (belt-and-suspenders with stopGame)
  game().getAudio()?.menuMusic();
  resetRoute(); // quitting a game is a fresh root — clear the in-app back stack
}

// ═══ URL routing ════════════════════════════════════════════════════════════════════════════════
// Navigation is mirrored to the browser URL (History API). A FORWARD move — opening a screen, a
// settings page, or a battle overlay — pushes a history entry; a BACK move — the browser Back
// button, the ESC key, or any in-app Back / Done button — lands on the parent. All three are kept
// consistent so they behave identically ("go up one level"). Inert until initRouter() runs (only
// main.tsx boot calls it), so the history-less unit-test environment is completely untouched.

const hasHistory = typeof window !== 'undefined' && typeof window.history?.pushState === 'function';
let routerOn = false; // initRouter() flips this on in the browser; stays false under test
let routeDepth = 0; // in-app history depth (0 = the entry page): lets a back fall through to a parent
let applyingRoute = false; // guards the popstate reconcile from re-pushing

const TOP_SCREEN: Partial<Record<string, Screen>> = {
  '': 'menu',
  play: 'setup',
  network: 'network',
  about: 'about',
  manual: 'manual',
  highscores: 'highscores',
  settings: 'settings',
  battle: 'battle',
};

/** The URL path representing the current navigation signals. */
function currentPath(): string {
  switch (screen.value) {
    case 'settings':
      return settingsPage.value === 'root' ? '/settings' : `/settings/${settingsPage.value}`;
    case 'battle':
      if (showHelp.value) return '/battle/help';
      if (showDepot.value) return '/battle/depot';
      if (showPause.value) return '/battle/pause';
      return '/battle';
    case 'setup':
      return '/play';
    case 'network':
      return '/network';
    case 'about':
      return '/about';
    case 'manual':
      return '/manual';
    case 'highscores':
      return '/highscores';
    default:
      return '/';
  }
}

/** The full URL written to history: the current path plus the PRESERVED query string and hash, so
 *  `?dev`/test params (`?battle`, `?land`, `?settings`, `?weapontest`…) stay alive across navigation
 *  instead of being dropped by a path-only history write (`?land` is re-read on every new battle). */
function navUrl(): string {
  return currentPath() + window.location.search + window.location.hash;
}

/** Base category id (strips the `~<n>` pagination suffix). */
const baseOf = (id: string): string => id.split('~')[0];
/** The page one level up from `id` in the Settings tree (editors nest under `content`; everything
 *  else — including paginated sub-pages, whose Done returns to root — sits directly under root). */
const parentPage = (id: string): string =>
  id === 'root' ? 'root' : id.includes('.') ? id.split('.')[0] : 'root';

/** Push a forward entry for the just-changed navigation state. */
function pushRoute(): void {
  if (!routerOn || applyingRoute) return;
  if (currentPath() === window.location.pathname) return;
  routeDepth += 1;
  window.history.pushState({d: routeDepth}, '', navUrl());
}

/** Rewrite the current entry to the just-changed state (no new history entry). */
function replaceRoute(): void {
  if (!routerOn || applyingRoute) return;
  window.history.replaceState({d: routeDepth}, '', navUrl());
}

/** Pop one entry after an in-app back (state already changed synchronously). Falls back to
 *  rewriting the URL when there's nothing to pop (a deep link opened straight onto a child). */
function popRoute(): void {
  if (!routerOn || applyingRoute) return;
  if (routeDepth > 0)
    window.history.back(); // popstate reconciles (a no-op: state already matches)
  else window.history.replaceState({d: 0}, '', navUrl());
}

/** Reset history to the current state as a fresh root (quitting a game / boot). */
function resetRoute(): void {
  if (!routerOn) return;
  routeDepth = 0;
  window.history.replaceState({d: 0}, '', navUrl());
}

/** Show exactly one (or no) battle overlay, matching the sim-freeze to it. Idempotent. */
function reconcileOverlay(kind: '' | 'pause' | 'help' | 'depot'): void {
  if (kind === 'depot' && !showDepot.value) refreshEconomy();
  showPause.value = kind === 'pause';
  showHelp.value = kind === 'help';
  showDepot.value = kind === 'depot';
  const wantFrozen = kind !== '';
  if (wantFrozen && !paused.value) freezeSim();
  else if (!wantFrozen && paused.value) unfreezeSim();
}

/** Drive the navigation signals (and their sim-freeze side effects) to match `path`. Absolute and
 *  idempotent — used by the popstate handler (browser Back/Forward) and any deep link. */
function routeTo(path: string): void {
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
  const target = TOP_SCREEN[parts[0] ?? ''] ?? 'menu';
  const sub = parts[1] ? decodeURIComponent(parts[1]) : '';

  if (target === 'battle') {
    if (screen.value !== 'battle') screen.value = 'battle';
    reconcileOverlay(sub === 'pause' || sub === 'help' || sub === 'depot' ? sub : '');
    return;
  }
  reconcileOverlay(''); // a non-battle screen has no overlay and must not stay sim-frozen
  if (target === 'menu' && screen.value === 'battle') {
    goToMenu(); // battle → menu needs the drive-audio stop + menu-music restart (see goToMenu)
    return;
  }
  screen.value = target;
  if (target === 'settings') settingsPage.value = sub || 'root';
}

/** Wire the browser Back/Forward buttons and seed the entry URL. Call once at boot. */
export function initRouter(): void {
  if (!hasHistory) return;
  routerOn = true;
  window.history.replaceState({d: 0}, '', navUrl());
  window.addEventListener('popstate', e => {
    routeDepth = (e.state as {d?: number} | null)?.d ?? 0;
    applyingRoute = true;
    try {
      routeTo(window.location.pathname);
    } finally {
      applyingRoute = false;
    }
  });
}

/** One level up — the shared action behind ESC and the on-screen Back / Done buttons. */
export function escapeBack(): void {
  if (loading.value) return; // navigation is locked while a match's textures load
  if (screen.value === 'battle') {
    if (showHelp.value) closeHelp();
    else if (showDepot.value) closeDepot();
    else if (showPause.value) resumeGame();
    else openPauseMenu(); // no overlay open: ESC opens the pause menu (a forward move)
  } else if (screen.value === 'settings') {
    if (settingsPage.value === 'root') closeSettings();
    else settingsPageBack();
  } else if (screen.value !== 'menu') {
    backToMenu();
  }
  // the main menu is the top level — ESC does nothing there
}

/** A match needs at least two teams (humans + computers) to have an opponent. */
export const MIN_PLAYERS = 2;

/** Common launch path: honour the saved options, set the counts, enter battle. */
function enterBattle(players: number, humans: number, tanksPerTeam: number): void {
  applyGameSettings(game()); // honour the saved options for this match
  game().setHumanCount(humans);
  game().setTanksPerTeam(tanksPerTeam);
  game().getAudio()?.startGameSound(); // the "chunk" as the battle launches
  game().startGame(players); // builds land + tanks, kicks off the texture load + battle music
  screen.value = 'battle';
  // A battle is a fresh ROOT, not a stack entry: browser Back can't wander back into /play (or the
  // menu) while the sim is live — the only way out is Quit (goToMenu), which tears the battle down.
  resetRoute();
  // Cover the still-untextured world with a menu-styled loading screen (at --z-modal, above the
  // now-mounted HUD) and keep the sim frozen so its shot-timer can't drain behind it. Reveal the
  // textured battle only once the sky + terrain textures have loaded, so the player never sees the
  // gradient-sky fallback. See LoadingScreen.
  const token = ++launchToken;
  loading.value = true;
  freezeSim();
  void game()
    .assetsReady()
    .then(() => {
      if (token !== launchToken) return; // a newer launch superseded this one — drop the reveal
      loading.value = false;
      // Resume the sim unless something opened an overlay over the battle while it loaded (a dev
      // URL flag such as ?pause / ?depot), which owns the freeze until it closes.
      if (!showPause.value && !showDepot.value && !showHelp.value) unfreezeSim();
    });
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
  uiMenuForward();
  pushRoute();
}

/** Quick Play → start immediately with the last-used setup. If that setup can't start a match
 *  (e.g. a persisted 1-human / 0-computer config), open the Play setup instead of silently doing
 *  nothing — a dead button with no feedback. */
export function quickPlay(): void {
  if (playersOf(setup.value) < MIN_PLAYERS) {
    openPlaySetup();
    return;
  }
  startBattle();
}

/** Main menu → Network Game (create / join a room). */
export function openNetworkGame(): void {
  screen.value = 'network';
  uiMenuForward();
  pushRoute();
}

/** A plain 2-player battle (dev URL affordances + boot) — does not touch the setup. */
export function playNewGame(): void {
  uiClick();
  enterBattle(2, 1, 1);
}

/** Main menu → About, and back. */
export function openAbout(): void {
  screen.value = 'about';
  uiMenuForward();
  pushRoute();
}

/** Main menu → Manual (the how-to-play document), and back. */
export function openManual(): void {
  screen.value = 'manual';
  uiMenuForward();
  pushRoute();
}

/** Main menu → High Scores (the Battle Heroes hall of fame). */
export function openHighScores(): void {
  screen.value = 'highscores';
  uiMenuForward();
  pushRoute();
}
export function backToMenu(): void {
  screen.value = 'menu';
  uiMenuBack();
  popRoute();
}

/** Quit the current battle back to the main menu (UI). */
export function quitToMenu(): void {
  goToMenu();
  uiClick();
}

/** Depot actions — mutate the controller's economy, then re-sync + play the buy/sell
 *  confirmation (Panel1.wav, as the original did — only on a successful transaction). */
export function depotBuy(i: number): void {
  if (controller?.buyWeapon(i)) {
    refreshEconomy();
    uiDepotTransaction();
  }
}

export function depotSell(i: number): void {
  if (controller?.sellWeapon(i)) {
    refreshEconomy();
    uiDepotTransaction();
  }
}

export function depotAutoBuy(): void {
  controller?.autoBuyWeapons();
  refreshEconomy();
  uiDepotTransaction();
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
    // Fire-and-forget the anonymous global play stats (one uploader per net match; always in solo).
    if (game().isStatsUploader()) void postGameStats(game().getMatchStats());
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
  notice: string; // transient hint below the battle line ("Can't move underground."), '' = none
}>({lines: [], battle: '', notice: ''});

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
/** A screen / dialog panel opening (Panel1.wav). */
export function uiOpen(): void {
  controller?.getAudio()?.uiOpen();
}
/** …and closing (Panel3.wav). */
export function uiClose(): void {
  controller?.getAudio()?.uiClose();
}
/** Depot buy / sell confirmation (Panel1.wav — the original's buy/sell sound). */
export function uiDepotTransaction(): void {
  controller?.getAudio()?.depotTransaction();
}
/** A keystroke while typing a name (typing.wav). */
export function uiTyping(): void {
  controller?.getAudio()?.typingSound();
}

/** Front-end menu polish sounds (Pacdot2 / Mechanismus1 / Mechanismus2). */
/** Blip as the highlighted menu item changes (menu-list hover). */
export function uiMenuHover(): void {
  controller?.getAudio()?.menuHover();
}
/** Navigating INTO a menu screen from the main menu (Play / Settings / About / …). */
export function uiMenuForward(): void {
  controller?.getAudio()?.menuForward();
}
/** Stepping Back to the main menu. */
export function uiMenuBack(): void {
  controller?.getAudio()?.menuBack();
}

/** Copy the current game state into the signals (called each frame). */
export function syncHud(): void {
  const c = controller;
  if (!c) return;
  // No battle yet (fresh boot → main menu): there is no current tank / economy / status to
  // mirror, so skip the whole per-frame HUD sync until the first match starts.
  if (!c.isStarted()) return;
  // Safety net: if the depot is open but buying is no longer allowed (the turn moved on — e.g. a
  // server turn hand-off in a net match), close it so a stale depot can't buy/sell for another tank.
  if (showDepot.value && !c.canOpenDepot()) closeDepot();
  power.value = Math.round(c.getPower());
  angle.value = Math.round(c.getAngle());
  wind.value = c.getWindValue();
  weaponIndex.value = c.getCurrentWeaponIndex();
  // The selectable list can change with the turn or a buy/sell (the human's control-weapon lock vs.
  // a bot's full arsenal; a purchased weapon replacing a spent one). Refresh only when the actual
  // sequence changes — compare element refs (WEAPON_DATABASE entries are stable), NOT just length +
  // first: the staple (Shell) is ALWAYS first, so a length+first guard misses a same-length swap
  // (e.g. Shell+Rocket → Shell+Nuke) and leaves the HUD showing the previous arsenal.
  const defs = c.getWeaponDefs() as WeaponDef[];
  const cur = weapons.value;
  if (defs.length !== cur.length || defs.some((d, i) => d !== cur[i])) {
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
  canFire.value = c.canAct();
  canBuyNow.value = c.canOpenDepot();
  flying.value = c.isFlying();
  jetFuel.value = c.getJetFuel();
  // The single input gate: held when paused, not the human's live turn, OR while the tank is
  // auto-driving a Move / in jet flight (canAct). Disables the whole HUD + aim until it settles.
  blocked.value = !c.canAct();
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
  const notice = c.getStatusNotice(); // "Can't move underground." while the acting tank is buried
  const sig =
    lines.map(l => l.text + l.color + l.dead + l.active).join('|') + '#' + battle + '#' + notice;
  if (sig !== lastBattleSig) {
    lastBattleSig = sig;
    battleStatus.value = {lines, battle, notice};
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
export type BmpKey = 'magenta' | 'green' | 'grey' | 'greyblack' | 'black' | 'blackmagenta';
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
  // black background + magenta registration pixels both keyed — the angle-dial pointer
  // (guiAnglePointerBig.bmp) is a red needle on black with a few magenta mount pixels.
  blackmagenta: (p, i) =>
    (p[i] < 40 && p[i + 1] < 40 && p[i + 2] < 40) ||
    (p[i] > 200 && p[i + 1] < 70 && p[i + 2] > 200),
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
      const {cv, ctx: g} = makeCanvas2d(img.width, img.height);
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

/** Load a weapon icon at the given native pixel size (16 | 32). Only magenta
 *  keys out — the grey (128,128,128) tile is the icon's intended background. Icon
 *  files are lowercase; Vite serves public assets case-sensitively. */
export function loadWeaponIcon(name: string, size: 16 | 32 = 32): Promise<string | null> {
  return loadColorKeyedBmp(
    iconCache,
    `${size}/${name}`,
    encodeURI(`/assets/icons/${size}x${size}/${name.toLowerCase()}.bmp`),
    KEYERS.magenta,
  );
}
