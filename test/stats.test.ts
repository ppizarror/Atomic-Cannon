/**
 * Global play stats: the incremental delta is clamped (client + server share sanitizeDelta), the
 * controller drains only what's new since the last flush, and only the right client uploads (solo
 * always; in a net match only localIndex 0, never a spectator). Flag emoji derive from the ISO code.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameType, type StatsFlush} from '../src/game/CGameController';
import {Roster} from '../src/core/CRoster';
import type {CTank} from '../src/core/CTank';
import {sanitizeDelta, STAT_CAPS, emptyDelta, isEmptyDelta, mergeDelta} from '../src/net/stats';
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
  randomizePosition: false,
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
      playSec: 100,
      online: true,
    });
    expect(d.weaponsFired).toBe(0); // negative → 0
    expect(d.shotsFired).toBe(STAT_CAPS.shotsFired); // over cap → cap
    expect(d.tanksDestroyed).toBe(3); // floored
    expect(d.damageDealt).toBe(0); // NaN → 0
    expect(d.playSec).toBe(100);
    expect(d.online).toBe(true);
  });

  it('missing fields default to 0 and online defaults false', () => {
    const d = sanitizeDelta({});
    expect(d.shotsFired).toBe(0);
    expect(d.creditsSpent).toBe(0);
    expect(d.online).toBe(false);
  });

  it('a fresh delta is empty; any progress or play makes it worth sending', () => {
    expect(isEmptyDelta(emptyDelta())).toBe(true);
    expect(isEmptyDelta({...emptyDelta(), battles: 1})).toBe(false);
    expect(isEmptyDelta({...emptyDelta(), shotsFired: 3})).toBe(false);
  });

  it('merging a failed upload back in sums the play but keeps longest-war a max', () => {
    const a = {...emptyDelta(), battles: 1, shotsFired: 4, playSec: 30, warSec: 300};
    const b = {...emptyDelta(), battles: 2, shotsFired: 5, playSec: 20, warSec: 100, online: true};
    const m = mergeDelta(a, b);
    expect(m.battles).toBe(3);
    expect(m.shotsFired).toBe(9);
    expect(m.playSec).toBe(50); // play time accumulates
    expect(m.warSec).toBe(300); // "longest" is a max, never a sum
    expect(m.online).toBe(true);
  });
});

describe('controller match stats', () => {
  it('a solo match tallies a fire and is the stats uploader', () => {
    const gc = new CGameController(makeCanvas());
    gc.setGameType(EGameType.Deathmatch);
    gc.startGame(2);
    gc.setAngle(45);
    gc.setPower(600);

    gc.takeStatsDelta(); // drain the match-start baseline
    gc.fire();
    const after = gc.takeStatsDelta();

    expect(after.weaponsFired).toBe(1);
    expect(after.shotsFired).toBeGreaterThanOrEqual(after.weaponsFired); // ≥1 projectile per fire
    expect(after.online).toBe(false);
    expect(gc.isStatsUploader()).toBe(true); // solo always uploads
  });

  it('each drain reports only what is new — the same shot is never uploaded twice', () => {
    const gc = new CGameController(makeCanvas());
    gc.startGame(2);
    gc.setAngle(45);
    gc.setPower(600);
    gc.fire();

    const first = gc.takeStatsDelta({battles: 1});
    expect(first.weaponsFired).toBe(1);
    expect(first.battles).toBe(1);
    expect(first.wars).toBe(0); // a mid-war battle flush never closes the war

    const second = gc.takeStatsDelta();
    expect(second.weaponsFired).toBe(0); // already banked
    expect(second.battles).toBe(0);
  });

  it('a war-closing flush counts one war and reports the whole war duration', () => {
    const gc = new CGameController(makeCanvas());
    gc.startGame(2);
    const d = gc.takeStatsDelta({battles: 1, warOver: true});
    expect(d.wars).toBe(1);
    expect(d.battles).toBe(1);
    expect(d.warSec).toBeGreaterThanOrEqual(0);
    expect(gc.takeStatsDelta().wars).toBe(0); // and only that one flush counts it
  });

  it('a finished battle banks the match immediately — no click on the standings', () => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.setGameType(EGameType.Deathmatch);
    gc.setTotalBattles(1); // one battle = the whole war
    gc.startGame(2);
    const flushes: StatsFlush[] = [];
    gc.setStatsListener(f => flushes.push(f));

    const tanks = (gc as unknown as {m_tanks: CTank[]; endTurn(): void}).m_tanks;
    tanks[1].hit(999999); // one team left → the battle (and the war) ends
    (gc as unknown as {endTurn(): void}).endTurn();

    expect(flushes).toContainEqual({battles: 1, warOver: true});
  });

  it('an unfinished war banks the battle but not the war', () => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas());
    gc.setGameType(EGameType.Deathmatch);
    gc.setTotalBattles(3); // battle 1 of 3 — the war goes on
    gc.startGame(2);
    const flushes: StatsFlush[] = [];
    gc.setStatsListener(f => flushes.push(f));

    const tanks = (gc as unknown as {m_tanks: CTank[]}).m_tanks;
    tanks[1].hit(999999);
    (gc as unknown as {endTurn(): void}).endTurn();

    expect(flushes).toContainEqual({battles: 1, warOver: false});
  });

  it('startGame resets the per-match tally', () => {
    const gc = new CGameController(makeCanvas());
    gc.startGame(2);
    gc.setAngle(45);
    gc.setPower(600);
    gc.fire();
    gc.startGame(2); // fresh match — the un-drained tally goes with it
    expect(gc.takeStatsDelta().weaponsFired).toBe(0);
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
