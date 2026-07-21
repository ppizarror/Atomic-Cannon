/**
 * Play setup — the human/CPU split reaches the match (the first N tanks are human,
 * the rest CPU), and the persisted setup store clamps sensibly.
 * Run: pnpm tsx tests/setup.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';
import {setup, setSetup, cpuOf, MIN_TANKS, MAX_TANKS} from '../src/ui/setupStore';

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

// 1. Human count: the first N tanks are human, the rest CPU.
{
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(2);
  gc.startGame(4);
  const t = (gc as unknown as Tanks).m_tanks;
  ok('first two tanks are human', t[0].isHuman() && t[1].isHuman());
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

// 3. Default is one human (unchanged legacy behaviour).
{
  const gc = new CGameController(makeCanvas());
  gc.startGame(3);
  const t = (gc as unknown as Tanks).m_tanks;
  ok('default: only the first tank is human', t[0].isHuman() && !t[1].isHuman() && !t[2].isHuman());
}

// 4. The setup store clamps total to [MIN,MAX] and humans to [0,total].
{
  setSetup({total: 999, humans: 999});
  ok('total clamps to the max', setup.value.total === MAX_TANKS);
  ok('humans never exceeds total', setup.value.humans === MAX_TANKS);

  setSetup({total: -5, humans: -5});
  ok('total clamps to the min', setup.value.total === MIN_TANKS);
  ok('humans clamps to zero', setup.value.humans === 0);

  setSetup({total: 4, humans: 1});
  ok('cpu = total − humans', cpuOf(setup.value) === 3);
}

console.log(`\n${pass}/${pass + fail} setup checks passed`);
process.exit(fail ? 1 : 0);
