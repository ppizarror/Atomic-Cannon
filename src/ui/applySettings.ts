/**
 * Bridge from the persisted Settings to the live game. Reads the engine-facing
 * values (settings.ts) and pushes them into the controller. Start-time values
 * (credits, land shape, battles) are stored on the controller and consumed by the
 * next `startGame`; the rest take effect immediately.
 *
 * Called at boot and before each new game (so a fresh match honours the options),
 * and again whenever an option changes (so live settings update at once).
 */
import type {CGameController} from '../game/CGameController';
import {GameConfig} from '../core/CGameConfig';
import {GameContent} from '../core/CGameContent';
import {Roster} from '../core/CRoster';
import {Taunts} from '../core/CTaunts';
import {gameSettings as S} from './settingsValues';
import {weaponsOff, landsOff} from './contentStore';
import {tauntLines} from './tauntsStore';
import {roster} from './playersStore';
import {showFramerate, showFrameCount} from './store';

export function applyGameSettings(c: CGameController): void {
  // Controller-owned: most read at the next startGame, a few live.
  c.setStartCredits(S.creditStart());
  c.setSellRate(S.sellRate());
  c.setCreditDamage(S.creditDamage());
  c.setCreditKill(S.creditKill());
  c.setCreditTurn(S.creditTurn());
  c.setCreditRound(S.creditRound());
  c.setTotalBattles(S.battles());
  c.setTotalRounds(S.rounds());
  c.setGameType(S.gameType());
  c.setVariance(S.variance());
  c.setGameSpeed(S.gameSpeed());
  c.setWindScale(S.windScale());
  c.setLandMode(S.landMode());
  c.setDifficulty(S.difficulty());

  // Cross-cutting scalars + render toggles, read directly off GameConfig
  // by the tank badge / shot launch / blast / render-gate sites.
  GameConfig.landSize = S.landSize(); // world-width multiplier (applied at next startGame)
  GameConfig.kickbackScale = S.kickbackScale();
  GameConfig.explosionScale = S.explosionScale();
  GameConfig.powerScale = S.powerScale();
  GameConfig.tankSizeScale = S.tankSizeScale();
  GameConfig.hitpoints = S.hitpoints();
  GameConfig.drawSmoke = S.drawSmoke();
  GameConfig.colorizeTeam = S.colorizeTeam();
  GameConfig.chatter = S.chatter();
  GameConfig.crateChance = S.crateChance();
  GameConfig.showTeamColor = S.showTeamColor();
  GameConfig.showPowerBars = S.showPowerBars();
  GameConfig.showTankStats = S.showTankStats();
  GameConfig.tracking = S.tracking();
  GameConfig.showTurn = S.showTurn();
  GameConfig.showPoints = S.showPoints(); // floating damage numbers per hit
  GameConfig.autoScroll = S.autoScroll(); // camera follows the shot / active tank
  GameConfig.showLastAim = S.showLastAim();
  GameConfig.explosionWaves = S.explosionWaves();
  GameConfig.blastCircles = S.blastCircles();
  GameConfig.highContrast = S.highContrast();
  GameConfig.showAiStats = S.showAiStats();
  GameConfig.demo = S.demo();
  // Framerate overlay (top-right DOM readouts): FPS at mode ≥ 1, + frame count at Full.
  const frameMode = S.framerate();
  showFramerate.value = frameMode >= 1;
  showFrameCount.value = frameMode >= 2;

  // Active weapon/landscape selection for the NEXT match (Game Content editors).
  GameContent.weaponsOff = new Set(weaponsOff.value);
  GameContent.landsOff = new Set(landsOff.value);

  // Player roster (name / model / colour) for the NEXT match (Customize Players).
  Roster.players = roster.value.map(p => ({name: p.name, model: p.model, color: p.color}));

  // Taunt message lists (Customize Taunts) — copy the effective (edited-or-default)
  // lines into the engine's live pool, dropping any blank editor rows. (Edits also
  // push live via tauntsStore; this is the boot / new-game safety net.)
  const clean = (l: string[]) => l.map(s => s.trim()).filter(s => s.length > 0);
  Taunts.death = clean(tauntLines('death'));
  Taunts.postFire = clean(tauntLines('postFire'));
  Taunts.taunt = clean(tauntLines('taunt'));

  // Force a repaint: a display toggle (Show AI Stats, High Contrast, …) changes what
  // the scene should draw, but nothing "moved", so the present-on-demand gate would
  // otherwise keep showing the stale frame until the next real change.
  c.markDirty();
}
