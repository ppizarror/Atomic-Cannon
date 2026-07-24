/**
 * Credit-earning economy: hit() reports actual life removed, per-tank last-damager,
 * per-tank credits, depot bound to the human tank, per-team credit pooling, and the
 * damage-credit award.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CTank} from '../src/core/CTank';
import {CGameController, EGameType} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {Roster} from '../src/core/CRoster';

// Teams are grouped by tank colour; use two alternating colours so N players form the
// classic even/odd two-team split the pooling / survivor tests rely on.
// Build a roster that puts `n` players onto two alternating teams (0,1,0,1,…) BY PLAYER ORDER.
// The match reads humans from roster slots 0.. and CPUs from the bot pool (slots 8..), so we colour
// each player's actual slot — otherwise a 1-human/3-CPU match would read uncoloured filler slots.
function twoTeamRoster(n: number, humans = 1): void {
  const roster = Array.from({length: 16}, (_, i) => ({name: `Filler${i}`, model: '', color: '#333333'}));
  for (let p = 0; p < n; p++) {
    const slot = p < humans ? p : 8 + (p - humans); // mirrors setupTanks' human/bot split
    roster[slot] = {name: `P${p}`, model: '', color: p % 2 === 0 ? '#0000ff' : '#ff0000'};
  }
  Roster.players = roster;
}

type Tanks = {m_tanks: CTank[]};

describe('Earning economy', () => {
  it('hit() returns the life actually removed (the credited quantity)', () => {
    const t = new CTank('T', 0); // 1000 life, no shield/armor
    // plain hit returns full life removed
    expect(t.hit(100)).toBe(100);
    expect(t.getHealth().nLife).toBe(900);

    const s = new CTank('S', 0);
    s.addShield(200); // shield covers the hit
    // shield fully absorbs → 0 credited
    expect(s.hit(100)).toBe(0);
    expect(s.getHealth().nLife).toBe(1000);
    expect(s.getHealth().nShield).toBe(100);

    const s2 = new CTank('S2', 0);
    s2.addShield(50); // shield < dmg → breaks, full dmg passes
    // shield break passes full damage
    expect(s2.hit(100)).toBe(100);
    expect(s2.getHealth().nLife).toBe(900);

    const a = new CTank('A', 0);
    a.setArmor(50); // 50% reduction
    // armor halves the credited life
    expect(a.hit(100)).toBe(50);
    expect(a.getHealth().nLife).toBe(950);

    const o = new CTank('O', 0);
    o.hit(970); // down to 30
    // overkill credits only remaining life
    expect(o.hit(100)).toBe(30);
    expect(o.getHealth().nLife).toBe(0);
    expect(o.isAlive()).toBe(false);
  });

  it('controller tracks per-tank credits, clears last-damager on spawn, binds the depot to the human', () => {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(2000);
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0],
      bot = tanks[1];

    // player 0 human, player 1 bot
    expect(human.isHuman()).toBe(true);
    expect(bot.isHuman()).toBe(false);
    // each tank starts with the configured credits
    expect(human.getCredits()).toBe(2000);
    expect(bot.getCredits()).toBe(2000);
    // last-damager cleared on spawn
    expect(human.getLastDamager()).toBeNull();
    expect(bot.getLastDamager()).toBeNull();

    // Depot is bound to the human tank's balance.
    expect(gc.getCredits()).toBe(2000); // depot reads the human tank credits
    human.addCredits(500); // "earning" the human tank
    expect(gc.getCredits()).toBe(2500); // earning the human tank shows in the depot

    const cheap = WEAPON_DATABASE.findIndex(w => w.cost > 0 && w.cost <= 1000);
    const cost = WEAPON_DATABASE[cheap].cost;
    const c0 = human.getCredits();
    // buying deducts from the human tank balance
    expect(gc.buyWeapon(cheap)).toBe(true);
    expect(human.getCredits()).toBe(c0 - cost);
  });

  it('a squad starts with perTeam × CreditStart (not a flat CreditStart)', () => {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(1000);
    gc.setTanksPerTeam(3); // 3-tank squads
    gc.startGame(2);
    const t = (gc as unknown as Tanks).m_tanks;

    // Every member is seeded with the squad-scaled purse; pooling then shares one balance,
    // so a 3-tank squad spends against 3 × 1000, matching the original's tanksPerTeam×CreditStart.
    for (const tk of t) expect(tk.getCredits()).toBe(3000);
    expect(gc.getCredits()).toBe(3000); // the human depot reads the scaled balance
  });

  it('credits pool per team', () => {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(1000);
    twoTeamRoster(4);
    gc.startGame(4);
    const t = (gc as unknown as Tanks).m_tanks; // teams 0,1,0,1

    t[0].setCredits(1777);
    (gc as unknown as {poolTeamCredits(tk: CTank): void}).poolTeamCredits(t[0]);
    expect(t[2].getCredits()).toBe(1777); // pooling copies to the same-team tank
    // pooling leaves the other team alone
    expect(t[1].getCredits()).toBe(1000);
    expect(t[3].getCredits()).toBe(1000);
  });

  it('enemy damage credits the shooter; self/friendly earns nothing; last-damager always recorded', () => {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(0);
    gc.setCreditDamage(2);
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0],
      bot = tanks[1]; // teams 0 and 1
    const priv = gc as unknown as {creditDamage(s: CTank | null, v: CTank, r: number): void};

    human.setCredits(0);
    priv.creditDamage(human, bot, 100); // enemy, 100 life removed
    expect(human.getCredits()).toBe(200); // enemy damage credits removed × CreditDamage
    expect(bot.getLastDamager()).toBe(human); // damage records the victim last-damager

    const ally = new CTank('Ally', human.getTeamId());
    human.setCredits(0);
    priv.creditDamage(human, ally, 100); // same team
    expect(human.getCredits()).toBe(0); // friendly-fire earns no credit
    expect(ally.getLastDamager()).toBe(human); // friendly-fire still records last-damager

    human.setCredits(0);
    priv.creditDamage(human, bot, 0); // e.g. shield-absorbed
    expect(human.getCredits()).toBe(0); // zero life removed earns nothing

    // End-to-end through applyBlast (owner threaded, life delta captured & credited).
    human.setCredits(0);
    const lifeBefore = bot.getHealth().nLife;
    gc.applyBlast(bot.getPosition(), 50, 100, human, false);
    const removed = lifeBefore - bot.getHealth().nLife;
    // applyBlast credits damage end-to-end
    expect(removed).toBeGreaterThan(0);
    expect(human.getCredits()).toBe(removed * 2);
  });

  it('kill credit is Deathmatch-only: enemy +CreditKill, team/self −CreditKill, unattributed nothing', () => {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(0);
    gc.setCreditKill(500);
    gc.setGameType(EGameType.Deathmatch);
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0],
      bot = tanks[1]; // teams 0 and 1
    const priv = gc as unknown as {awardKillCredit(v: CTank): void};

    bot.setLastDamager(human);
    human.setCredits(0);
    priv.awardKillCredit(bot);
    expect(human.getCredits()).toBe(500); // enemy kill awards +CreditKill

    const mate = new CTank('Mate', human.getTeamId());
    mate.setLastDamager(human);
    human.setCredits(1000);
    priv.awardKillCredit(mate); // team kill → penalty
    expect(human.getCredits()).toBe(500); // team kill applies −CreditKill penalty

    const orphan = new CTank('Orphan', 1); // never damaged → no killer
    human.setCredits(0);
    priv.awardKillCredit(orphan);
    expect(human.getCredits()).toBe(0); // unattributed death awards nothing

    gc.setGameType(EGameType.Rounds);
    bot.setLastDamager(human);
    human.setCredits(0);
    priv.awardKillCredit(bot);
    expect(human.getCredits()).toBe(0); // no kill credit outside Deathmatch
  });

  it('Kills stat: +1 for an enemy kill, −1 for a friendly/self kill (never below 0)', () => {
    const gc = new CGameController(makeCanvas());
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0],
      bot = tanks[1]; // teams 0 and 1
    const priv = gc as unknown as {handleTankDestroyed(t: CTank): void};

    bot.setLastDamager(human); // enemy kill
    priv.handleTankDestroyed(bot);
    expect(human.getKills()).toBe(1); // enemy kill → +1

    const mate = new CTank('Mate', human.getTeamId());
    mate.setLastDamager(human); // friendly-fire kill
    priv.handleTankDestroyed(mate);
    expect(human.getKills()).toBe(0); // team kill → −1 (1 → 0), matching the credit penalty

    const mate2 = new CTank('Mate2', human.getTeamId());
    mate2.setLastDamager(human);
    priv.handleTankDestroyed(mate2);
    expect(human.getKills()).toBe(0); // clamped — never goes negative
  });

  it('a lethal blast credits both damage and the kill bounty', () => {
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(0);
    gc.setCreditDamage(1);
    gc.setCreditKill(500);
    gc.setGameType(EGameType.Deathmatch);
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0],
      bot = tanks[1];

    human.setCredits(0);
    const botLife = bot.getHealth().nLife;
    gc.applyBlast(bot.getPosition(), 50, 2000, human, false); // lethal
    // lethal blast credits damage + kill
    expect(bot.isAlive()).toBe(false);
    expect(human.getCredits()).toBe(botLife + 500);
  });

  it('turn and round awards pay every survivor and pool per team', () => {
    // Team multiplier + dead exclusion (4 players → teams 0,1,0,1).
    const gc4 = new CGameController(makeCanvas());
    gc4.setStartCredits(0);
    twoTeamRoster(4);
    gc4.startGame(4);
    const t4 = (gc4 as unknown as Tanks).m_tanks;
    const award = gc4 as unknown as {awardSurvivorCredit(n: number): void};

    award.awardSurvivorCredit(100);
    // team of 2 earns perTank × members
    expect(t4[0].getCredits()).toBe(200);
    expect(t4[2].getCredits()).toBe(200);
    expect(t4[1].getCredits()).toBe(200);

    t4[2].hit(99999); // kill one team-0 member
    t4[0].setCredits(0);
    award.awardSurvivorCredit(100);
    expect(t4[0].getCredits()).toBe(100); // dead teammate excluded from the multiplier

    // Turn every hand-off; Round on wrap (Round then Turn), isolated from damage/kill.
    const gc = new CGameController(makeCanvas());
    gc.setStartCredits(0);
    gc.setCreditDamage(0);
    gc.setCreditKill(0);
    gc.setCreditTurn(10);
    gc.setCreditRound(100);
    gc.startGame(2);
    const tanks = (gc as unknown as Tanks).m_tanks;
    const human = tanks[0],
      bot = tanks[1];
    const priv = gc as unknown as {endTurn(): void};

    priv.endTurn(); // 0 → 1, no wrap
    // turn award pays every survivor
    expect(human.getCredits()).toBe(10);
    expect(bot.getCredits()).toBe(10);

    priv.endTurn(); // 1 → 0, wrap: +Round then +Turn
    // round wrap pays Round then Turn
    expect(human.getCredits()).toBe(120);
    expect(bot.getCredits()).toBe(120);
  });
});
