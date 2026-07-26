/**
 * Global play stats: the per-match delta is clamped (client + server share sanitizeDelta), the
 * controller tallies fires/spend per match, and only the right client uploads (solo always; in a
 * net match only localIndex 0, never a spectator). Country flag emoji derive from the ISO code.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameType} from '../src/game/CGameController';
import {sanitizeDelta, STAT_CAPS} from '../src/net/stats';
import {flagEmoji, countryName} from '../src/ui/worldGeo';

const ROSTER = [
  {name: 'A', color: '#f00'},
  {name: 'B', color: '#0f0'},
];
const CFG = {
  hitpoints: 1000,
  tankSizeScale: 1,
  explosionScale: 1,
  powerScale: 1,
  kickbackScale: 1,
  buryTanks: false,
  variance: true,
  relativeTurrets: false,
  utilityTurn: false,
  roundTime: 0,
  crateChance: 20,
  radiationDamage: true,
  startCredits: 3000,
  gameType: 1,
  sellRate: 0.5,
  creditDamage: 1,
  creditKill: 500,
  creditTurn: 0,
  creditRound: 1000,
};
function netAt(localIndex: number): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.startNetworkGame({
    seed: 7,
    players: 2,
    localIndex,
    roster: ROSTER,
    wind: 1,
    mapSize: 2,
    battles: 2,
    tanksPerTeam: 1,
    currentBattle: 1,
    viewW: 1280,
    viewH: 720,
    config: CFG,
  });
  return gc;
}

describe('stats delta sanitize', () => {
  it('clamps negatives / NaN / over-cap, floors, and preserves the online flag', () => {
    const d = sanitizeDelta({
      weaponsFired: -5,
      shotsFired: 1e12,
      tanksDestroyed: 3.9,
      damageDealt: NaN,
      gameSec: 100,
      online: true,
    });
    expect(d.weaponsFired).toBe(0); // negative → 0
    expect(d.shotsFired).toBe(STAT_CAPS.shotsFired); // over cap → cap
    expect(d.tanksDestroyed).toBe(3); // floored
    expect(d.damageDealt).toBe(0); // NaN → 0
    expect(d.gameSec).toBe(100);
    expect(d.online).toBe(true);
  });

  it('missing fields default to 0 and online defaults false', () => {
    const d = sanitizeDelta({});
    expect(d.shotsFired).toBe(0);
    expect(d.creditsSpent).toBe(0);
    expect(d.online).toBe(false);
  });
});

describe('controller match stats', () => {
  it('a solo match tallies a fire and is the stats uploader', () => {
    const gc = new CGameController(makeCanvas());
    gc.setGameType(EGameType.Deathmatch);
    gc.startGame(2);
    gc.setAngle(45);
    gc.setPower(600);

    const before = gc.getMatchStats();
    gc.fire();
    const after = gc.getMatchStats();

    expect(after.weaponsFired).toBe(before.weaponsFired + 1);
    expect(after.shotsFired).toBeGreaterThanOrEqual(after.weaponsFired); // ≥1 projectile per fire
    expect(after.online).toBe(false);
    expect(gc.isStatsUploader()).toBe(true); // solo always uploads
  });

  it('startGame resets the per-match tally', () => {
    const gc = new CGameController(makeCanvas());
    gc.startGame(2);
    gc.setAngle(45);
    gc.setPower(600);
    gc.fire();
    expect(gc.getMatchStats().weaponsFired).toBeGreaterThan(0);
    gc.startGame(2); // fresh match
    expect(gc.getMatchStats().weaponsFired).toBe(0);
  });

  it('in a net match only localIndex 0 uploads; a spectator never does', () => {
    expect(netAt(0).isStatsUploader()).toBe(true); // first in turn order
    expect(netAt(1).isStatsUploader()).toBe(false); // another player
    expect(netAt(-1).isStatsUploader()).toBe(false); // spectator
  });
});

describe('country display helpers', () => {
  it('derives flag emoji and names from the ISO code', () => {
    expect(flagEmoji('US')).toBe('🇺🇸');
    expect(flagEmoji('cl')).toBe('🇨🇱'); // case-insensitive
    expect(flagEmoji('??')).toBe('🏳️'); // invalid → white flag
    expect(countryName('XX')).toBe('Unknown');
  });
});
