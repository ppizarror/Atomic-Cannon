/**
 * Credit-earning economy: hit() reports actual life removed, per-tank last-damager,
 * per-tank credits, depot bound to the human tank, per-team credit pooling, and the
 * damage-credit award.
 * Run: pnpm tsx tests/earning.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CTank} from '../src/core/CTank';
import {CGameController, EGameType} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';

let pass = 0,
  fail = 0;

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

type Tanks = {m_tanks: CTank[]};

console.log('Earning economy');

// 1. hit() returns the LIFE actually removed (post shield + armor) — the credited qty.
{
  const t = new CTank('T', 0); // 1000 life, no shield/armor
  ok(
    'plain hit returns full life removed',
    t.hit(100) === 100 && t.getHealth().nLife === 900,
    `nLife=${t.getHealth().nLife}`,
  );

  const s = new CTank('S', 0);
  s.addShield(200); // shield covers the hit
  ok(
    'shield fully absorbs → 0 credited',
    s.hit(100) === 0 && s.getHealth().nLife === 1000 && s.getHealth().nShield === 100,
  );

  const s2 = new CTank('S2', 0);
  s2.addShield(50); // shield < dmg → breaks, full dmg passes
  ok('shield break passes full damage', s2.hit(100) === 100 && s2.getHealth().nLife === 900);

  const a = new CTank('A', 0);
  a.setArmor(50); // 50% reduction
  ok('armor halves the credited life', a.hit(100) === 50 && a.getHealth().nLife === 950);

  const o = new CTank('O', 0);
  o.hit(970); // down to 30
  ok(
    'overkill credits only remaining life',
    o.hit(100) === 30 && o.getHealth().nLife === 0 && !o.isAlive(),
  );
}

// 2-4. Controller: per-tank credits, last-damager cleared on spawn, depot binding.
{
  const gc = new CGameController(makeCanvas());
  gc.setStartCredits(2000);
  gc.startGame(2);
  const tanks = (gc as unknown as Tanks).m_tanks;
  const human = tanks[0],
    bot = tanks[1];

  ok('player 0 human, player 1 bot', human.isHuman() && !bot.isHuman());
  ok(
    'each tank starts with the configured credits',
    human.getCredits() === 2000 && bot.getCredits() === 2000,
    `h=${human.getCredits()} b=${bot.getCredits()}`,
  );
  ok(
    'last-damager cleared on spawn',
    human.getLastDamager() === null && bot.getLastDamager() === null,
  );

  // Depot is bound to the human tank's balance.
  ok('depot reads the human tank credits', gc.getCredits() === 2000, `d=${gc.getCredits()}`);
  human.addCredits(500); // "earning" the human tank
  ok('earning the human tank shows in the depot', gc.getCredits() === 2500, `d=${gc.getCredits()}`);

  const cheap = WEAPON_DATABASE.findIndex(w => w.cost > 0 && w.cost <= 1000);
  const cost = WEAPON_DATABASE[cheap].cost;
  const c0 = human.getCredits();
  ok(
    'buying deducts from the human tank balance',
    gc.buyWeapon(cheap) && human.getCredits() === c0 - cost,
    `h=${human.getCredits()} cost=${cost}`,
  );
}

// 5. Per-team credit pooling (4 players → teams 0,1,0,1).
{
  const gc = new CGameController(makeCanvas());
  gc.setStartCredits(1000);
  gc.startGame(4);
  const t = (gc as unknown as Tanks).m_tanks; // teams 0,1,0,1

  t[0].setCredits(1777);
  (gc as unknown as {poolTeamCredits(tk: CTank): void}).poolTeamCredits(t[0]);
  ok('pooling copies to the same-team tank', t[2].getCredits() === 1777, `t2=${t[2].getCredits()}`);
  ok(
    'pooling leaves the other team alone',
    t[1].getCredits() === 1000 && t[3].getCredits() === 1000,
    `t1=${t[1].getCredits()} t3=${t[3].getCredits()}`,
  );
}

// 6. Damage credit: shooter earns `lifeRemoved × CreditDamage` for ENEMY
//    hits only; self/friendly earns nothing; last-damager is always recorded.
{
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
  ok(
    'enemy damage credits removed × CreditDamage',
    human.getCredits() === 200,
    `c=${human.getCredits()}`,
  );
  ok('damage records the victim last-damager', bot.getLastDamager() === human);

  const ally = new CTank('Ally', human.getTeamId());
  human.setCredits(0);
  priv.creditDamage(human, ally, 100); // same team
  ok('friendly-fire earns no credit', human.getCredits() === 0);
  ok('friendly-fire still records last-damager', ally.getLastDamager() === human);

  human.setCredits(0);
  priv.creditDamage(human, bot, 0); // e.g. shield-absorbed
  ok('zero life removed earns nothing', human.getCredits() === 0);

  // End-to-end through applyBlast (owner threaded, life delta captured & credited).
  human.setCredits(0);
  const lifeBefore = bot.getHealth().nLife;
  gc.applyBlast(bot.getPosition(), 50, 100, human, false);
  const removed = lifeBefore - bot.getHealth().nLife;
  ok(
    'applyBlast credits damage end-to-end',
    removed > 0 && human.getCredits() === removed * 2,
    `rm=${removed} c=${human.getCredits()}`,
  );
}

// 7. Kill credit — Deathmatch only; enemy kill pays +CreditKill, team/self kill
//    pays −CreditKill, unattributed death pays nothing.
{
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
  ok('enemy kill awards +CreditKill', human.getCredits() === 500, `c=${human.getCredits()}`);

  const mate = new CTank('Mate', human.getTeamId());
  mate.setLastDamager(human);
  human.setCredits(1000);
  priv.awardKillCredit(mate); // team kill → penalty
  ok(
    'team kill applies −CreditKill penalty',
    human.getCredits() === 500,
    `c=${human.getCredits()}`,
  );

  const orphan = new CTank('Orphan', 1); // never damaged → no killer
  human.setCredits(0);
  priv.awardKillCredit(orphan);
  ok('unattributed death awards nothing', human.getCredits() === 0);

  gc.setGameType(EGameType.Rounds);
  bot.setLastDamager(human);
  human.setCredits(0);
  priv.awardKillCredit(bot);
  ok('no kill credit outside Deathmatch', human.getCredits() === 0);
}

// 8. End-to-end lethal blast: the shooter earns damage credit AND the kill bounty.
{
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
  ok(
    'lethal blast credits damage + kill',
    !bot.isAlive() && human.getCredits() === botLife + 500,
    `c=${human.getCredits()} life=${botLife}`,
  );
}

// 9. Turn / Round awards — every survivor earns per turn; a completed round (turn
//    order wraps) pays Credit Round then Credit Turn. Credits pool per team.
{
  // Team multiplier + dead exclusion (4 players → teams 0,1,0,1).
  const gc4 = new CGameController(makeCanvas());
  gc4.setStartCredits(0);
  gc4.startGame(4);
  const t4 = (gc4 as unknown as Tanks).m_tanks;
  const award = gc4 as unknown as {awardSurvivorCredit(n: number): void};

  award.awardSurvivorCredit(100);
  ok(
    'team of 2 earns perTank × members',
    t4[0].getCredits() === 200 && t4[2].getCredits() === 200 && t4[1].getCredits() === 200,
    `t0=${t4[0].getCredits()}`,
  );

  t4[2].hit(99999); // kill one team-0 member
  t4[0].setCredits(0);
  award.awardSurvivorCredit(100);
  ok(
    'dead teammate excluded from the multiplier',
    t4[0].getCredits() === 100,
    `t0=${t4[0].getCredits()}`,
  );
}
{
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
  ok(
    'turn award pays every survivor',
    human.getCredits() === 10 && bot.getCredits() === 10,
    `h=${human.getCredits()}`,
  );

  priv.endTurn(); // 1 → 0, wrap: +Round then +Turn
  ok(
    'round wrap pays Round then Turn',
    human.getCredits() === 120 && bot.getCredits() === 120,
    `h=${human.getCredits()}`,
  );
}

console.log(`\n${pass}/${pass + fail} earning checks passed`);
process.exit(fail ? 1 : 0);
