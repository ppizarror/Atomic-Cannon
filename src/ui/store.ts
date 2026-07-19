/**
 * UI store — signals mirroring the live game state, pumped once per frame.
 *
 * Preact reads these signals; the game controller never touches the DOM. Screens
 * (menu / settings / depot) switch on `screen`.
 */
import { signal } from '@preact/signals';
import type { CGameController } from '../game/CGameController';
import type { WeaponDef } from '../core/CWeapon';

export type Screen = 'menu' | 'battle' | 'settings' | 'depot';

export const screen = signal<Screen>('battle');

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
export const winner = signal('');
export const screenFlash = signal(0);   // full-viewport white-out intensity (0..1)

export const weapons = signal<WeaponDef[]>([]);

// Power/angle ranges (UI units).
export const POWER_MIN = 10, POWER_MAX = 1000;
export const ANGLE_MIN = 0, ANGLE_MAX = 180;

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
  winner.value = c.getWinnerName();
  screenFlash.value = c.getScreenFlash();
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
      cv.width = img.width; cv.height = img.height;
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
