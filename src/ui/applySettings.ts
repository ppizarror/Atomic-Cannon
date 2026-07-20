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
import { GameConfig } from '../core/CGameConfig';
import { gameSettings as S } from './settingsValues';

export function applyGameSettings(c: CGameController): void {
  // Controller-owned: most read at the next startGame, a few live.
  c.setStartCredits(S.creditStart());
  c.setSellRate(S.sellRate());
  c.setTotalBattles(S.battles());
  c.setVariance(S.variance());
  c.setGameSpeed(S.gameSpeed());
  c.setWindScale(S.windScale());
  c.setLandMode(S.landMode());
  c.setDifficulty(S.difficulty());

  // Cross-cutting scalars + render toggles, read directly off GameConfig
  // by the tank badge / shot launch / blast / render-gate sites.
  GameConfig.kickbackScale = S.kickbackScale();
  GameConfig.explosionScale = S.explosionScale();
  GameConfig.powerScale = S.powerScale();
  GameConfig.hitpoints = S.hitpoints();
  GameConfig.colorizeTeam = S.colorizeTeam();
  GameConfig.showTeamColor = S.showTeamColor();
  GameConfig.showPowerBars = S.showPowerBars();
  GameConfig.showTankStats = S.showTankStats();
  GameConfig.tracking = S.tracking();
  GameConfig.showTurn = S.showTurn();
  GameConfig.showLastAim = S.showLastAim();
  GameConfig.explosionWaves = S.explosionWaves();
}
