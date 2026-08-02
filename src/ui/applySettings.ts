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
import {gameSettings as S, engineValue} from './settingsValues';
import {SETTINGS, type SettingId} from './settingsCatalog';
import {weaponsOff, landsOff} from './contentStore';
import {tauntLines} from './tauntsStore';
import {roster} from './playersStore';
import {showFramerate, showFrameCount, maxFps} from './store';

/**
 * Seed every settings-mirror field of GameConfig from the persisted Settings. This is the ONLY
 * writer of those fields — GameConfig itself holds inert placeholders, so the catalog is the
 * single source of truth for every default. Called from applyGameSettings (boot + each game + on
 * any change) and from the test setup, so the same catalog-derived defaults apply in-game and in
 * unit tests.
 */
export function applyGameConfig(): void {
  // The key is a SettingsMirrorKey, so it IS a real GameConfig field; the index signature is
  // just to write it dynamically (the catalog's boolean/number kind matches the field's type).
  const cfg = GameConfig as unknown as Record<string, number | boolean>;
  for (const id of Object.keys(SETTINGS) as SettingId[]) {
    const target = SETTINGS[id].cfg;
    if (target) cfg[target] = engineValue(id);
  }
}

export function applyGameSettings(c: CGameController): void {
  // A LIVE network match runs the host's shared MatchConfig (applied once in startNetworkGame).
  // A local Settings change mid-match must NOT re-derive the simulation config from THIS client's
  // own options — different physics scalars / game speed / wind would silently break lockstep.
  // Skip while a net match is active; the next solo game (m_netMode off) applies settings again.
  if (c.isNetBattleActive()) {
    c.markDirty();
    return;
  }
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

  // Every GameConfig field (scalars + render toggles), read directly off GameConfig by the tank
  // badge / shot launch / blast / render-gate sites. The catalog is the sole default source.
  applyGameConfig();

  // Framerate overlay (top-right DOM readouts): FPS at mode ≥ 1, + frame count at Full.
  const frameMode = S.framerate();
  showFramerate.value = frameMode >= 1;
  showFrameCount.value = frameMode >= 2;
  maxFps.value = S.maxFps(); // ticker FPS cap (0 = uncapped) — the loop applies it

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
