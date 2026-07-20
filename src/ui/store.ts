/**
 * UI store — signals mirroring the live game state, pumped once per frame.
 *
 * Preact reads these signals; the game controller never touches the DOM. Screens
 * (menu / settings / depot) switch on `screen`.
 */
import {signal} from '@preact/signals';
import type {CGameController} from '../game/CGameController';
import type {WeaponDef} from '../core/CWeapon';

export type Screen = 'menu' | 'battle' | 'settings' | 'depot' | 'about';

export const screen = signal<Screen>('battle');


// Weapons Depot overlay — buy/sell screen shown above the battle HUD.
export const showDepot = signal(false);
// Economy state, mirrored from the controller on demand (not every frame — it only
// changes on buy/sell). `owned[i]` = rounds for weapon i (Infinity = unlimited).
export const credits = signal(0);
export const ownedCounts = signal<number[]>([]);
export const mapName = signal('');

/** Pull the current credits + inventory into the signals (after a buy/sell/open). */
export function refreshEconomy(): void {
    const c = controller;
    if (!c) return;
    credits.value = c.getCredits();
    ownedCounts.value = c.getOwnedCounts();
    mapName.value = c.getMapName();
}

/** Open/close the depot (refreshes the economy snapshot on open). */
export function openDepot(): void {
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

// Help overlay — the "?" panel button. The original shows a help/tutorial overlay
// and highlights each control (RE: flag this+0x97f → tutorial state this+0xa1c);
// our port shows a modal control reference. Freeze the sim while it's up so the
// shot-timer doesn't drain behind it.
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

/** Open the Settings screen, remembering where to return (pause vs main menu). */
export function openSettings(from: 'pause' | 'menu'): void {
    settingsOrigin.value = from;
    showPause.value = false;
    screen.value = 'settings';
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

/** Play → start a fresh battle. */
export function playNewGame(): void {
    uiClick();
    game().startGame(2);          // also starts the battle music
    screen.value = 'battle';
    game().setPaused(false);
    paused.value = false;
}

/** Main menu → About, and back. */
export function openAbout(): void { screen.value = 'about'; uiClick(); }
export function backToMenu(): void { screen.value = 'menu'; uiClick(); }

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
export const shield = signal(0);
export const canFire = signal(false);
// True whenever the HUD controls should read as "held": the game is paused, or
// it's not the human's live turn (shot in flight, explosion, a bot playing). The
// panel greys out and stops responding while this is set.
export const blocked = signal(true);
export const winner = signal('');
export const screenFlash = signal(0);   // full-viewport white-out intensity (0..1)
export const screenFlashColor = signal('#ffffff');   // flash tint (the bomb's colour)

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
// green→yellow→red colour, or null when there's no active countdown (RE: the
// shot-time frame in FUN_00474ff0). Republished only when the quantised width
// or colour changes, so the bar animates without churning every frame.
export const turnTimer = signal<{ frac: number; color: string } | null>(null);

// Top-left status overlay: per-tank life lines (team-coloured) + the battle/shot
// line — "%s: %d%% life" and "Battle %d of %d - Shot %d" (RE: FUN_0048c480).
export const battleStatus = signal<{
    lines: { text: string; color: string; dead: boolean; active: boolean }[];
    battle: string
}>({lines: [], battle: ''});

// Power/angle ranges (UI units). Angle is a full circle measured CCW from
// horizontal-right and WRAPS at the ends: 0 = right, 90 = up, 180 = left,
// 270 = straight down, 315 = down-right. Stepping past 359 wraps to 0 (and 0 → 359),
// so below-horizon aim reads 181..359 rather than going negative.
export const POWER_MIN = 10, POWER_MAX = 1000;
export const ANGLE_MIN = 0, ANGLE_MAX = 359;

/** Fold any angle (deg) into the wrapping 0..359 range the HUD uses. */
export const wrapAngle = (deg: number): number => ((deg % 360) + 360) % 360;

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
    const h = c.getCurrentTank().getHealth();
    life.value = Math.max(0, Math.round(h.nLife));
    shield.value = Math.max(0, Math.round(h.nShield));
    canFire.value = c.isPlayerTurn();
    flying.value = c.isFlying();
    jetFuel.value = c.getJetFuel();
    // Held when paused or when it isn't the human's live turn (see `blocked`).
    blocked.value = c.isPaused() || !c.isPlayerTurn();
    winner.value = c.getWinnerName();
    screenFlash.value = c.getScreenFlash();
    screenFlashColor.value = c.getScreenFlashColor();

    // Top-left status text — only re-publish when it actually changes so the
    // bitmap-font lines don't re-render every frame.
    const lines = c.getTankStatuses().map(s => ({
        text: `${s.name}: ${s.lifePct}% life`,
        color: s.color,
        dead: !s.alive,
        active: s.active
    }));
    const battle = `Battle ${c.getBattleNum()} of ${c.getTotalBattles()} - Shot ${c.getShotCount()}`;
    const sig = lines.map(l => l.text + l.color + l.dead + l.active).join('|') + '#' + battle;
    if (sig !== lastBattleSig) {
        lastBattleSig = sig;
        battleStatus.value = {lines, battle};
    }

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
export type BmpKey = 'magenta' | 'green' | 'grey' | 'greyblack';
const isGrey = (p: Uint8ClampedArray, i: number) =>
    Math.abs(p[i] - 64) < 26 && Math.abs(p[i + 1] - 64) < 26 && Math.abs(p[i + 2] - 64) < 26;
const KEYERS: Record<BmpKey, (p: Uint8ClampedArray, i: number) => boolean> = {
    magenta: (p, i) => p[i] > 200 && p[i + 1] < 70 && p[i + 2] > 200,
    green: (p, i) => p[i] < 70 && p[i + 1] > 200 && p[i + 2] < 70,
    grey: isGrey,
    // grey outside + black corner outline both keyed — the zeon dialog with its
    // black rounded-corner border stripped (legacy tooltips have no black border).
    greyblack: (p, i) => isGrey(p, i) || (p[i] < 40 && p[i + 1] < 40 && p[i + 2] < 40),
};

/** Load an /assets BMP, knock out the `key` colour as transparency, cache it.
 * Used for the depot's colour-keyed UI art (sort arrows, tooltip dialog/pointer). */
export function loadUiBmp(path: string, key: BmpKey = 'magenta'): Promise<string | null> {
    const cacheKey = `${path}#${key}`;
    const cached = bmpCache.get(cacheKey);
    if (cached) return cached;
    const p = new Promise<string | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement('canvas');
            cv.width = img.width;
            cv.height = img.height;
            const g = cv.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const im = g.getImageData(0, 0, cv.width, cv.height);
            const px = im.data;
            const hit = KEYERS[key];
            for (let i = 0; i < px.length; i += 4) {
                if (hit(px, i)) px[i + 3] = 0;
            }
            g.putImageData(im, 0, 0);
            resolve(cv.toDataURL());
        };
        img.onerror = () => resolve(null);
        img.src = encodeURI(path.startsWith('/') ? path : `/assets/${path}`);
    });
    bmpCache.set(cacheKey, p);
    return p;
}

// --- weapon icons: load the BMP, knock out magenta, cache as a data URL -------
const iconCache = new Map<string, Promise<string | null>>();

/** Load a weapon icon at the given native pixel size (12 | 16 | 32). */
export function loadWeaponIcon(name: string, size: 12 | 16 | 32 = 32): Promise<string | null> {
    const key = `${size}/${name}`;
    const cached = iconCache.get(key);
    if (cached) return cached;

    const p = new Promise<string | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement('canvas');
            cv.width = img.width;
            cv.height = img.height;
            const g = cv.getContext('2d')!;
            g.drawImage(img, 0, 0);
            const im = g.getImageData(0, 0, cv.width, cv.height);
            const px = im.data;
            // Only magenta (255,0,255) is the transparency key — the grey (128,128,128)
            // tile is the icon's intended background and must be kept (like the original).
            for (let i = 0; i < px.length; i += 4) {
                if (px[i] > 200 && px[i + 1] < 70 && px[i + 2] > 200) px[i + 3] = 0;
            }
            g.putImageData(im, 0, 0);
            resolve(cv.toDataURL());
        };
        img.onerror = () => resolve(null);
        // Icon files are lowercase; Vite serves public assets case-sensitively.
        img.src = encodeURI(`/assets/icons/${size}x${size}/${name.toLowerCase()}.bmp`);
    });
    iconCache.set(key, p);
    return p;
}
