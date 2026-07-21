/**
 * Play setup — the human/CPU split and squad size (tanks per team) reach the match:
 * the first N teams are human, each team fields `tanksPerTeam` tanks that share a
 * colour, total capped at 16. The persisted setup store clamps to the binary ranges.
 * Run: pnpm tsx tests/setup.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';
import {setup, setSetup, playersOf, MAX_HUMANS, MAX_TANKS_PER_TEAM} from '../src/ui/setupStore';

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

console.log('Play setup');

// 1. Human count: the first N teams are human, the rest CPU (1 tank each).
{
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(2);
  gc.setTanksPerTeam(1);
  gc.startGame(4);
  const t = (gc as unknown as Tanks).m_tanks;
  ok('four teams → four tanks', t.length === 4);
  ok('first two are human', t[0].isHuman() && t[1].isHuman());
  ok('the rest are CPU', !t[2].isHuman() && !t[3].isHuman());
}

// 2. Watch mode: zero humans → every tank is CPU.
{
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(0);
  gc.startGame(2);
  const t = (gc as unknown as Tanks).m_tanks;
  ok('watch mode has no human', !t[0].isHuman() && !t[1].isHuman());
}

// 3. Squads: each team fields `tanksPerTeam` tanks sharing that team's colour.
{
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.setTanksPerTeam(3);
  gc.startGame(2); // 2 teams × 3 tanks = 6
  const t = (gc as unknown as Tanks).m_tanks;
  ok('2 teams × 3 tanks = 6 tanks', t.length === 6);
  ok("team 1's squad is human", t[0].isHuman() && t[1].isHuman() && t[2].isHuman());
  ok("team 2's squad is CPU", !t[3].isHuman() && !t[4].isHuman() && !t[5].isHuman());
  ok('a squad shares one colour/team', t[0].getTeamId() === t[2].getTeamId());
  ok('the two squads are different teams', t[0].getTeamId() !== t[3].getTeamId());
  ok('exactly two teams on the field', new Set(t.map(x => x.getTeamId())).size === 2);
}

// 4. Total tanks cap at 16 (8 teams × 5 would be 40).
{
  const gc = new CGameController(makeCanvas());
  gc.setTanksPerTeam(5);
  gc.startGame(8);
  const t = (gc as unknown as Tanks).m_tanks;
  ok('total tanks capped at 16', t.length === 16);
}

// 5. The initial (default) setup is always a startable match (≥ 2 players).
{
  ok(
    'default setup has an opponent',
    playersOf(setup.value) >= 2,
    `players=${playersOf(setup.value)}`,
  );
}

// 6. The setup store clamps to the binary ranges.
{
  setSetup({humans: 99, computers: 99, tanksPerTeam: 99});
  ok('humans clamps to max', setup.value.humans === MAX_HUMANS);
  ok('tanks clamps to max', setup.value.tanksPerTeam === MAX_TANKS_PER_TEAM);

  setSetup({humans: -3, computers: -3, tanksPerTeam: -3});
  ok('humans clamps to zero', setup.value.humans === 0);
  ok('tanks clamps to one', setup.value.tanksPerTeam === 1);

  setSetup({humans: 2, computers: 3, tanksPerTeam: 1});
  ok('players = humans + computers', playersOf(setup.value) === 5);

  // A setup from the old {total, humans} schema (no computers / tanksPerTeam) must not
  // yield NaN — the missing fields fall back to sensible defaults.
  setSetup({total: 4, humans: 1} as unknown as Parameters<typeof setSetup>[0]);
  ok(
    'legacy setup never produces NaN',
    Number.isFinite(setup.value.computers) && Number.isFinite(setup.value.tanksPerTeam),
    `c=${setup.value.computers} t=${setup.value.tanksPerTeam}`,
  );
}

console.log(`\n${pass}/${pass + fail} setup checks passed`);
process.exit(fail ? 1 : 0);
