/**
 * Ultra's read of the OTHER tanks — the layer above "solve an arc and fire it":
 *  • its own squad is scored, so it doesn't splash teammates to hit an enemy;
 *  • it converges the squad on the weakest enemy, because kills pay and wounded tanks still shoot;
 *  • it reads the enemy arsenal (weapons are visible) and answers a nuke by digging in behind a beam;
 *  • it weighs how much radiation a destination would actually cost instead of vetoing any speck;
 *  • it shoots back at a teammate who has been shelling its own side, and — late, and only for the
 *    personalities inclined to it — at one who is about to take the win off them.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {
  planUltraTurn,
  bestOffensiveShot,
  ULTRA_PERSONALITIES,
  NO_THREAT,
  type UltraAlly,
  type UltraCtx,
  type UltraEnemy,
  type UltraWeapon,
  type UltraThreat,
} from '../src/core/CBotUltraAI';
import {CGameController} from '../src/game/CGameController';
import {AI_LEVEL_ULTRA} from '../src/core/CBotAI';
import {Roster} from '../src/core/CRoster';

const GY = 500; // flat ground

const weapon = (o: Partial<UltraWeapon> = {}): UltraWeapon => ({
  index: 0,
  ext: 0,
  cost: 0,
  count: Infinity,
  damage: 100,
  radius: 40,
  innerR: 5,
  spread: 0,
  dotValue: 0,
  earth: 0,
  piercing: false,
  isBeam: false,
  isCleaner: false,
  isMine: false,
  isPremium: false,
  offensive: true,
  ...o,
});

const enemy = (o: Partial<UltraEnemy> = {}): UltraEnemy => ({
  x: 700,
  y: GY - 10,
  life: 1000,
  maxLife: 1000,
  shield: 0,
  hitRadius: 12,
  buried: false,
  ...o,
});

const ally = (o: Partial<UltraAlly> = {}): UltraAlly => ({
  x: 300,
  y: GY - 10,
  life: 1000,
  maxLife: 1000,
  shield: 0,
  hitRadius: 12,
  betrayal: 0,
  score: 0,
  ...o,
});

function ctx(over: Partial<UltraCtx> = {}): UltraCtx {
  return {
    self: {
      x: 200,
      y: GY - 10,
      life: 1000,
      maxLife: 1000,
      shield: 0,
      armor: 0,
      hazmat: 0,
      credits: 0,
      onRadiation: false,
      buried: false,
      threatened: false,
      score: 0,
    },
    enemies: [enemy()],
    weapons: [weapon()],
    crates: [],
    field: {heightAt: () => GY, width: 1000, height: 620},
    wind: {x: 0, y: 0},
    gustT0: 0,
    muzzleFor: () => ({x: 200, y: GY - 20}),
    aimDegToward: t => (Math.atan2(-(t.y - (GY - 20)), t.x - 200) * 180) / Math.PI,
    moveMaxDist: 300,
    radiationAt: () => false,
    mines: [],
    rnd: () => 0.5,
    ...over,
  };
}

// ── Squad discipline ─────────────────────────────────────────────────────────────────────────────

describe('Ultra does not shoot its own squad', () => {
  const wide = weapon({index: 3, damage: 300, radius: 200}); // blast wide enough to catch both

  it('refuses a shot whose blast would also catch a teammate', () => {
    const enemies = [enemy({x: 700, life: 300})];
    const clean = bestOffensiveShot(ctx({enemies, weapons: [wide]}));
    // Same shot, but a teammate is standing right beside the target.
    const withAlly = bestOffensiveShot(ctx({enemies, weapons: [wide], allies: [ally({x: 705})]}));
    expect(clean!.value).toBeGreaterThan(withAlly?.value ?? -Infinity);
  });

  it('prices a friendly KILL far below any damage it would trade for', () => {
    const enemies = [enemy({x: 700, life: 1000})];
    const shot = bestOffensiveShot(
      ctx({enemies, weapons: [wide], allies: [ally({x: 700, life: 60})]}), // ally dies to this blast
    );
    expect(shot!.value).toBeLessThan(0); // never worth it
  });
});

// ── Focus fire ───────────────────────────────────────────────────────────────────────────────────

describe('Ultra focuses the weakest enemy', () => {
  it('prefers the wounded tank over the healthy one at equal reach', () => {
    // Far enough apart that one blast can't catch both — so the choice really is WHO to shoot.
    const enemies = [enemy({x: 700, life: 1000}), enemy({x: 400, life: 150})];
    const shot = bestOffensiveShot(ctx({enemies, weapons: [weapon({damage: 80, radius: 10})]}));
    expect(shot).not.toBeNull();
    expect(shot!.targetX).toBe(400); // the one that's nearly dead
  });

  it('scores a shot on the squad focus target above the same shot elsewhere', () => {
    const enemies = [enemy({x: 700})];
    const onFocus = bestOffensiveShot(ctx({enemies, focusX: 700}));
    const offFocus = bestOffensiveShot(ctx({enemies, focusX: 100}));
    expect(onFocus!.value).toBeGreaterThan(offFocus!.value);
  });
});

// ── Reading the opposition ───────────────────────────────────────────────────────────────────────

describe('Ultra reads the enemy arsenal', () => {
  const beam = weapon({index: 40, damage: 130, radius: 20, cost: 1000, count: 3, isBeam: true});
  const dirt = weapon({index: 28, damage: 25, radius: 15, cost: 300, count: 2, earth: 40});
  const nukeThreat: UltraThreat = {...NO_THREAT, hasNuke: true, bigBlastDamage: 500};

  it('buries itself when a nuke is pointed at it and it holds a beam + dirt', () => {
    const plan = planUltraTurn(
      ctx({
        // Nothing worth shooting: the enemy is untouched and far, so the turtle play can win the turn.
        enemies: [enemy({x: 900, life: 1000})],
        weapons: [beam, dirt],
        threat: nukeThreat,
        weights: ULTRA_PERSONALITIES.cautious,
      }),
    );
    expect(plan.action).toBe('fire');
    if (plan.action === 'fire') {
      expect(plan.note).toBe('self-bury');
      expect(plan.weaponIndex).toBe(dirt.index);
      expect(plan.targetX).toBe(200); // its own column
    }
  });

  it('does NOT bury when the enemy also holds a beam — dirt hides it from nobody', () => {
    const plan = planUltraTurn(
      ctx({
        enemies: [enemy({x: 900, life: 1000})],
        weapons: [beam, dirt],
        threat: {...nukeThreat, hasBeam: true},
        weights: ULTRA_PERSONALITIES.cautious,
      }),
    );
    if (plan.action === 'fire') expect(plan.note).not.toBe('self-bury');
  });

  it('does NOT bury with no beam to fight back with — that is a cage, not cover', () => {
    const plan = planUltraTurn(
      ctx({
        enemies: [enemy({x: 900, life: 1000})],
        weapons: [dirt, weapon()],
        threat: nukeThreat,
        weights: ULTRA_PERSONALITIES.cautious,
      }),
    );
    if (plan.action === 'fire') expect(plan.note).not.toBe('self-bury');
  });
});

// ── Radiation as a cost, not a taboo ─────────────────────────────────────────────────────────────

describe('Ultra weighs how much radiation actually is', () => {
  // Enemy unreachable (positioning plays are on the table) and off to the RIGHT, with the crate to the
  // LEFT — so grabbing it moves AWAY from the enemy and isn't rejected as "closing on them for loot".
  const crateCtx = (dose: number): UltraCtx =>
    ctx({
      enemies: [enemy({x: 5000})],
      crates: [{x: 120, kind: 'weapon', amount: 0, landed: true}],
      radiationAt: x => Math.abs(x - 120) < 20,
      radiationCostAt: x => (Math.abs(x - 120) < 20 ? dose : 0),
    });

  it('crosses a thin fallout carpet for a weapon crate', () => {
    const plan = planUltraTurn(crateCtx(20));
    expect(plan.action).toBe('move');
    if (plan.action === 'move') expect(plan.note).toBe('crate:weapon');
  });

  it('refuses the same crate when the ground would cost a third of its life', () => {
    const plan = planUltraTurn(crateCtx(600));
    if (plan.action === 'move') expect(plan.note).not.toBe('crate:weapon');
  });
});

// ── Attack priority ──────────────────────────────────────────────────────────────────────────────

describe('Ultra attacks rather than potters about', () => {
  it('keeps firing while lightly hurt instead of healing', () => {
    const heal = weapon({index: 10, ext: 10, damage: 0, offensive: false, count: 1});
    const plan = planUltraTurn(
      ctx({
        weapons: [weapon({damage: 200}), heal],
        self: {...ctx().self, life: 550}, // under the 0.6 heal threshold, but a real shot is available
      }),
    );
    expect(plan.action).toBe('fire');
  });
});

// ── Loyalty, grudges and betrayal ────────────────────────────────────────────────────────────────

describe('Ultra and its allies', () => {
  const sniper = weapon({index: 2, damage: 250, radius: 12}); // tight blast — hits only what it aims at

  it('shoots BACK at a teammate who has been shelling its own side', () => {
    const traitor = ally({x: 600, betrayal: 500}); // well past the full-grudge threshold
    const shot = bestOffensiveShot(ctx({enemies: [enemy({x: 5000})], weapons: [sniper], allies: [traitor]}));
    expect(shot).not.toBeNull();
    expect(shot!.targetX).toBe(600); // the traitor, not the unreachable enemy
  });

  it('leaves a clean teammate alone even when they are the only thing in range', () => {
    const shot = bestOffensiveShot(ctx({enemies: [enemy({x: 5000})], weapons: [sniper], allies: [ally({x: 600})]}));
    expect(shot).toBeNull(); // no target worth a round
  });

  it('a RUTHLESS bot turns on the teammate who is about to take the win, but only at the end', () => {
    const leader = ally({x: 600, score: 40});
    const base = {
      enemies: [enemy({x: 5000})],
      weapons: [sniper],
      allies: [leader],
      weights: ULTRA_PERSONALITIES.ruthless,
      self: {...ctx().self, score: 5},
    };
    expect(bestOffensiveShot(ctx({...base, endgame: false}))).toBeNull(); // mid-battle: loyal
    const late = bestOffensiveShot(ctx({...base, endgame: true}));
    expect(late?.targetX).toBe(600); // battle decided, they're ahead → fair game
  });

  it('a CAUTIOUS bot never betrays, however far ahead the teammate is', () => {
    const shot = bestOffensiveShot(
      ctx({
        enemies: [enemy({x: 5000})],
        weapons: [sniper],
        allies: [ally({x: 600, score: 999})],
        weights: ULTRA_PERSONALITIES.cautious,
        endgame: true,
        self: {...ctx().self, score: 0},
      }),
    );
    expect(shot).toBeNull();
  });

  it('…but a cautious bot still shoots back at one that turned on IT', () => {
    const shot = bestOffensiveShot(
      ctx({
        enemies: [enemy({x: 5000})],
        weapons: [sniper],
        allies: [ally({x: 600, betrayal: 500})],
        weights: ULTRA_PERSONALITIES.cautious,
      }),
    );
    expect(shot?.targetX).toBe(600);
  });
});

// ── Fair play: the bot sees the panel, not the inventory ─────────────────────────────────────────

describe('Ultra only reads the weapons the HUD actually shows', () => {
  // Weapon-database indices used below. The arsenal strip lists the unlimited staple first, then
  // bought weapons in BUY order — and it is five rows tall, so row six onward is scrolled out of view.
  const FILLER = [4, 5, 6, 7, 8, 9]; // cheap, harmless rounds used to pad the buy order
  const A_BOMB = 42; // nuke-class ($4000)

  type Priv = {
    setHumanCount(n: number): void;
    setDifficulty(n: number): void;
    setStartCredits(n: number): void;
    startGame(n: number): void;
    economyFor(t: unknown): {
      buy(i: number): boolean;
      addCredits(n: number): void;
      getCredits(): number;
    };
    ultraThreatAgainst(t: unknown): {hasNuke: boolean};
    m_tanks: unknown[];
  };

  /** Enemy buys `before` filler rounds, then the nuke — so the nuke lands at arsenal row `before + 2`
   *  (row 1 is the staple). Returns whether our bot can see it. */
  const nukeVisibleAfter = (before: number): boolean => {
    Roster.players = [];
    const gc = new CGameController(makeCanvas(900, 600)) as unknown as Priv;
    gc.setHumanCount(0);
    gc.setDifficulty(AI_LEVEL_ULTRA);
    gc.setStartCredits(0); // no auto-restock muddying the buy order
    gc.startGame(2);
    const foe = gc.m_tanks[1];
    const econ = gc.economyFor(foe);
    econ.addCredits(999999);
    for (let i = 0; i < before; i++) econ.buy(FILLER[i]);
    econ.buy(A_BOMB);
    econ.addCredits(-econ.getCredits()); // broke, so affordability can't stand in for SEEING the round
    return gc.ultraThreatAgainst(gc.m_tanks[0]).hasNuke;
  };

  it('sees a nuke sitting in the visible rows', () => {
    expect(nukeVisibleAfter(3)).toBe(true); // row 5 of 5 — just on screen
  });

  it('does NOT see a nuke scrolled off the bottom of the strip', () => {
    expect(nukeVisibleAfter(4)).toBe(false); // row 6 — a human would have to scroll for this
    expect(nukeVisibleAfter(6)).toBe(false);
  });
});
