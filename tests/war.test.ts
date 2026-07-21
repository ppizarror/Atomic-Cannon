/**
 * "Winning the war" standings — per-tank war stats aggregate into per-team rows, the
 * leading team (most kills, tie-break life%) drives the title, and the battle→next-battle
 * flow keeps cumulative stats.
 * Run: pnpm tsx tests/war.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CGameController, EGameType} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';

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

type Priv = {m_tanks: CTank[]; endTurn(): void};

console.log('Winning the war');

// Three distinct-colour tanks = three teams (free-for-all).
function newGame(): CGameController {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setGameType(EGameType.Deathmatch);
  gc.setTotalBattles(5);
  gc.startGame(3);
  return gc;
}

// 1. Stats aggregate into team rows; the leader is most-kills.
{
  const gc = newGame();
  const t = (gc as unknown as Priv).m_tanks;
  // t[0] dominates: 5 kills, 10 shots, 8 hits, 800 dmg. t[1]: 2 kills. t[2]: none.
  for (let i = 0; i < 5; i++) t[0].addKill();
  for (let i = 0; i < 10; i++) t[0].addShot();
  for (let i = 0; i < 8; i++) t[0].addHit(100);
  t[1].addKill();
  t[1].addKill();
  // Kill t[1] and t[2] so only t[0]'s team survives → battle ends.
  t[1].hit(999999);
  t[2].hit(999999);
  (gc as unknown as Priv).endTurn();

  const s = gc.getWarStandings();
  ok('leader is the top-kills team', s.rows[0].isLeader && s.rows[0].kills === 5);
  ok('rows sorted by kills desc', s.rows[0].kills >= s.rows[1].kills);
  ok('team accuracy = hits/shots', Math.round(s.rows[0].accuracyPct) === 80);
  ok('damage/hit = damage/hits', Math.round(s.rows[0].damagePerHit) === 100);
  ok(
    'title names the leader, war ongoing',
    s.title === `${t[0].getName()} is winning the war.`,
    s.title,
  );
  ok('subtitle shows battle 1 of 5', s.subtitle.some(l => l.includes('1 of 5')));
  ok('war not over → play-next prompt', s.prompt.includes('play next battle'));
  ok('deathmatch shows the win condition', s.winCondition.length > 0);
}

// 2. Negative Damage/hit from friendly fire.
{
  const gc = newGame();
  const t = (gc as unknown as Priv).m_tanks;
  // One shot that only ever hit a teammate/self → net negative damage.
  t[0].addShot();
  t[0].addHit(-50); // friendly-fire contribution is stored negative
  const s = gc.getWarStandings();
  const row = s.rows.find(r => r.name === t[0].getName())!;
  ok('friendly fire yields negative damage/hit', row.damagePerHit === -50);
}

// 3. Final battle → "wins the war!" + exit prompt.
{
  const gc = newGame();
  const t = (gc as unknown as Priv).m_tanks;
  gc.setTotalBattles(1); // single battle → this IS the final
  t[0].addKill();
  t[1].hit(999999);
  t[2].hit(999999);
  (gc as unknown as Priv).endTurn();
  const s = gc.getWarStandings();
  ok('final battle title = wins the war', s.title === `${t[0].getName()} wins the war!`, s.title);
  ok('war over → exit prompt', s.prompt.includes('exit to menu'));
  ok('war over flag set', s.warOver);
}

// 4. Rounds mode → "wins the battle!", no war subtitle.
{
  const gc = newGame();
  gc.setGameType(EGameType.Rounds);
  const t = (gc as unknown as Priv).m_tanks;
  t[0].addKill();
  t[1].hit(999999);
  t[2].hit(999999);
  (gc as unknown as Priv).endTurn();
  const s = gc.getWarStandings();
  ok('rounds mode = wins the battle', s.title === `${t[0].getName()} wins the battle!`, s.title);
  ok('rounds mode uses the Points column', s.pointsMode);
  ok('rounds mode has no war subtitle', s.subtitle.length === 0);
}

// 5. nextBattle keeps cumulative stats and advances the counter.
{
  const gc = newGame();
  const t = (gc as unknown as Priv).m_tanks;
  t[0].addKill();
  t[0].addKill();
  gc.nextBattle();
  ok('battle counter advanced', gc.getBattleNum() === 2);
  ok('kills carry across battles', t[0].getKills() === 2);
  ok('tanks respawn to full life', t[0].isAlive() && t[1].isAlive() && t[2].isAlive());
}

console.log(`\n${pass}/${pass + fail} war checks passed`);
process.exit(fail ? 1 : 0);
