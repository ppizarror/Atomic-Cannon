/**
 * A bot must never spend a whole turn doing NOTHING — no shot, no drive. A wasted turn isn't just
 * dull to watch: the bot's situation doesn't change on its own, so whatever made it pass repeats next
 * round and it passes forever (observed: 17 consecutive skipped turns by one buried Ultra bot while
 * it held a beam and 30k credits).
 *
 * Covers the two ways that happened:
 *  • ULTRA — buried ⇒ beams only, but the beam line-of-sight check rejected every beam because the
 *    muzzle starts under the dirt, so the planner had zero candidates and returned `skip`.
 *  • levels 1..10 — the 25% move roll committed a drive that couldn't happen (buried tank) or covered
 *    no ground (already parked at the map-edge clamp, rolled into the wall), and waitForRest ended the
 *    turn the instant the tank wasn't moving.
 */
import {describe, it, expect, vi} from 'vitest';
import {makeCanvas} from './_dom';

import {planUltraTurn, type UltraCtx, type UltraWeapon} from '../src/core/CBotUltraAI';
import {CGameController} from '../src/game/CGameController';
import {AI_LEVEL_ULTRA} from '../src/core/CBotAI';
import {WEAPON_DATABASE, getWeapon} from '../src/core/CWeapon';
import {Roster} from '../src/core/CRoster';

// ── Pure planner ─────────────────────────────────────────────────────────────────────────────────

const shell: UltraWeapon = {
  index: 0,
  ext: 0,
  cost: 0,
  count: Infinity,
  damage: 250,
  radius: 30,
  innerR: 8,
  spread: 0,
  dotValue: 0,
  earth: 0,
  piercing: false,
  isBeam: false,
  isCleaner: false,
  isMine: false,
  isPremium: false,
  offensive: true,
};
const beam: UltraWeapon = {...shell, index: 40, ext: 5, cost: 900, count: 3, isBeam: true};

// Flat ground at y=500, one enemy 400px away. A buried bot's body — and so its muzzle — sits BELOW
// that surface, which is what the beam line-of-sight check used to trip on.
function ctx(buried: boolean, weapons: UltraWeapon[]): UltraCtx {
  const muzzleY = buried ? 515 : 475;
  return {
    self: {
      x: 200,
      y: buried ? 520 : 480,
      life: 1000,
      maxLife: 1000,
      shield: 500,
      armor: 100,
      hazmat: 100,
      credits: 30000,
      onRadiation: false,
      buried,
      threatened: false,
    },
    enemies: [{x: 600, y: 480, life: 800, maxLife: 1000, shield: 0, hitRadius: 12, buried: false}],
    weapons,
    crates: [],
    field: {heightAt: () => 500, width: 900, height: 600},
    wind: {x: 0, y: 0},
    gustT0: 0,
    muzzleFor: () => ({x: 200, y: muzzleY}),
    aimDegToward: t => (Math.atan2(-(t.y - muzzleY), t.x - 200) * 180) / Math.PI,
    moveMaxDist: buried ? 0 : 300, // buildUltraCtx zeroes the drive range while buried
    radiationAt: () => false,
    mines: [],
    rnd: () => 0.5,
  };
}

describe('Ultra AI never passes a turn', () => {
  it('fires its beam while buried instead of skipping', () => {
    const plan = planUltraTurn(ctx(true, [shell, beam]));
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') expect(plan.weaponIndex).toBe(beam.index);
  });

  it('blasts itself out with the cheapest round when buried with no beam and no cleaner', () => {
    const plan = planUltraTurn(ctx(true, [shell]));
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') {
      expect(plan.note).toBe('dig-blast');
      expect(plan.weaponIndex).toBe(shell.index); // cheapest — never a premium round
      expect(plan.targetX).toBe(200); // its own column, fired near-vertically
    }
  });

  it('still takes a normal shot when not buried', () => {
    expect(planUltraTurn(ctx(false, [shell, beam])).action).toBe('fire');
  });
});

// ── Controller: the level 1..10 move roll ────────────────────────────────────────────────────────

// Accessor views over the soft-private (`m_`) internals. Kept standalone rather than intersected with
// the real classes — intersecting a class that has private members collapses the type to `never`.
type Tank = {
  m_bBuried: boolean;
  m_driveTargetX: number | null;
  init(x: number, land: unknown): void;
  isMoving(): boolean;
  getPosition(): {x: number; y: number};
};
type Priv = {
  setHumanCount(n: number): void;
  setDifficulty(n: number): void;
  setStartCredits(n: number): void;
  startGame(n: number): void;
  economyFor(t: Tank): {getOwned(i: number): number};
  executeBotTurn(): void;
  botMove(t: Tank): boolean;
  m_tanks: Tank[];
  m_currentPlayerIndex: number;
  m_land: {width: number};
};

function newGame(level: number, credits = 3000): Priv {
  Roster.players = [];
  const gc = new CGameController(makeCanvas(900, 600)) as unknown as Priv;
  gc.setHumanCount(0);
  gc.setDifficulty(level);
  gc.setStartCredits(credits);
  gc.startGame(2);
  return gc;
}

describe('bot move never burns the turn', () => {
  it('declines the move when buried (so the turn falls through to firing)', () => {
    const gc = newGame(7);
    const tank = gc.m_tanks[0];
    tank.m_bBuried = true;
    expect(gc.botMove(tank)).toBe(false);
    expect(tank.isMoving()).toBe(false);
  });

  it('drives away from the wall when parked on the edge clamp', () => {
    const gc = newGame(7);
    const tank = gc.m_tanks[0];
    tank.init(20, gc.m_land as never); // parked hard against the left clamp
    // 0.1 → the distance roll, then direction = LEFT (into the wall). The old code clamped that
    // straight back onto x=20 and committed a zero-pixel drive.
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const moved = gc.botMove(tank);
    rnd.mockRestore();

    expect(moved).toBe(true);
    expect(tank.m_driveTargetX).not.toBeNull();
    expect(tank.m_driveTargetX! - tank.getPosition().x).toBeGreaterThan(8); // real ground, rightward
  });
});

describe('Ultra economy digs itself out', () => {
  it('buys a cleaner the turn it finds itself buried', () => {
    const gc = newGame(AI_LEVEL_ULTRA, 6000);
    const tank = gc.m_tanks[0];
    gc.m_currentPlayerIndex = 0;
    tank.m_bBuried = true;

    const owned = (): number => {
      const econ = gc.economyFor(tank);
      let n = 0;
      for (let i = 0; i < WEAPON_DATABASE.length; i++)
        if (getWeapon(i).isCleaner()) n += econ.getOwned(i);
      return n;
    };
    expect(owned()).toBe(0);

    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    gc.executeBotTurn(); // runs the Ultra economy pass, then acts
    rnd.mockRestore();

    expect(owned()).toBeGreaterThan(0);
  });
});
