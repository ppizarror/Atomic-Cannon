/**
 * Bridge from the persisted Settings to the live game. Reads the engine-facing
 * values (settings.ts) and pushes them into the controller. Start-time values
 * (credits, land shape, battles) are stored on the controller and consumed by the
 * next `startGame`; the rest take effect immediately.
 *
 * Called at boot and before each new game (so a fresh match honours the options),
 * and again whenever an option changes (so live settings update at once).
 */
import type { CGameController } from '../game/CGameController';
import { gameSettings as S } from './settingsValues';

export function applyGameSettings(c: CGameController): void {
  c.setStartCredits(S.creditStart());
  c.setSellRate(S.sellRate());
  c.setTotalBattles(S.battles());
  c.setVariance(S.variance());
  c.setGameSpeed(S.gameSpeed());
  c.setWindScale(S.windScale());
  c.setLandMode(S.landMode());
  c.setDifficulty(S.difficulty());
}
