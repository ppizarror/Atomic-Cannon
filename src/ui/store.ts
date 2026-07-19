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
export const power = signal(50);
export const angle = signal(45);
export const wind = signal(0);
export const weaponIndex = signal(0);
export const playerName = signal('');
export const teamColor = signal('#ff4444');
export const life = signal(1000);
export const shield = signal(0);
export const canFire = signal(false);
export const winner = signal('');

export const weapons = signal<WeaponDef[]>([]);

// Power/angle ranges (UI units).
export const POWER_MIN = 10, POWER_MAX = 100;
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

/** Copy the current game state into the signals (called each frame). */
export function syncHud(): void {
  const c = controller;
  if (!c) return;
  power.value = Math.round(c.getPower());
  angle.value = Math.round(c.getAngle());
  wind.value = c.getWindValue();
  weaponIndex.value = c.getCurrentWeaponIndex();
  playerName.value = c.getCurrentPlayerName();
  teamColor.value = c.getCurrentTeamColor();
  const h = c.getCurrentTank().getHealth();
  life.value = Math.max(0, Math.round(h.nLife));
  shield.value = Math.max(0, Math.round(h.nShield));
  canFire.value = c.isPlayerTurn();
  winner.value = c.getWinnerName();
}

// --- weapon icons: load the BMP, knock out magenta, cache as a data URL -------
const iconCache = new Map<string, Promise<string | null>>();

export function loadWeaponIcon(name: string): Promise<string | null> {
  const cached = iconCache.get(name);
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
      // Knock out whatever the top-left corner colour is (the sprite's key).
      const [kr, kg, kb] = [px[0], px[1], px[2]];
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i] - kr) < 24 && Math.abs(px[i + 1] - kg) < 24 && Math.abs(px[i + 2] - kb) < 24) px[i + 3] = 0;
      }
      g.putImageData(im, 0, 0);
      resolve(cv.toDataURL());
    };
    img.onerror = () => resolve(null);
    // Icon files are lowercase; Vite serves public assets case-sensitively.
    img.src = encodeURI(`/assets/icons/32x32/${name.toLowerCase()}.bmp`);
  });
  iconCache.set(name, p);
  return p;
}
