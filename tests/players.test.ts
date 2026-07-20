/**
 * Customize Players — the roster (name / tank model / colour) reaches the match, and
 * colour is the team identity: tanks sharing a colour are grouped onto one team,
 * distinct colours split into separate teams (free-for-all).
 * Run: pnpm tsx tests/players.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CGameController} from '../src/game/CGameController';
import {CTank, TEAM_COLORS} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';
import {roster, setColor, setName, MAX_PLAYERS} from '../src/ui/playersStore';
import {samplePalette} from '../src/ui/palette';

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

console.log('Customize Players');

// 1. Roster defaults: player 0 is "Player", colours are the distinct 16-palette.
{
  ok('roster holds up to 16 players', roster.value.length === MAX_PLAYERS);
  ok('player 1 is named "Player"', roster.value[0].name === 'Player');
  ok('player 1 defaults to the first palette colour', roster.value[0].color === TEAM_COLORS[0]);
  ok('player 2 defaults to a distinct colour', roster.value[1].color === TEAM_COLORS[1]);
}

// 2. Edits update (and would persist) the roster.
{
  setName(0, 'Ada');
  setColor(1, '#123456');
  ok('name edit applies', roster.value[0].name === 'Ada');
  ok('colour edit applies', roster.value[1].color === '#123456');
}

// 3. The roster reaches the match: tanks take their name / colour / model.
{
  Roster.players = [
    {name: 'Red1', model: 'MA1', color: '#ff0000'},
    {name: 'Red2', model: 'Green', color: '#ff0000'},
    {name: 'Blue1', model: 'MSPO', color: '#0000ff'},
    {name: 'Green1', model: 'Standard', color: '#00ff00'},
  ];
  const gc = new CGameController(makeCanvas());
  gc.startGame(4);
  const t = (gc as unknown as Tanks).m_tanks;

  ok('tanks take their roster names', t[0].getName() === 'Red1' && t[2].getName() === 'Blue1');
  ok(
    'tanks take their roster colours',
    t[0].getColor() === '#ff0000' && t[2].getColor() === '#0000ff',
  );
  ok(
    'tanks take their roster models',
    t[1].getTankType() === 'Green' && t[3].getTankType() === 'Standard',
  );

  // 4. Team = colour group: the two reds share a team, the others differ.
  ok('same colour → same team', t[0].getTeamId() === t[1].getTeamId());
  ok('different colour → different team', t[0].getTeamId() !== t[2].getTeamId());
  ok('three distinct colours → three teams', new Set(t.map(x => x.getTeamId())).size === 3);
}

// 5. An empty roster falls back to distinct per-player defaults (free-for-all).
{
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.startGame(3);
  const t = (gc as unknown as Tanks).m_tanks;
  ok('fallback colours are distinct', new Set(t.map(x => x.getColor())).size === 3);
  ok('fallback gives each its own team', new Set(t.map(x => x.getTeamId())).size === 3);
}

// 6. The palette sampler maps fractional coords to the pixel colour under them.
{
  // 2×1 image: left = red, right = blue.
  const data = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
  } as unknown as ImageData;
  ok('samples the left pixel at fx=0', samplePalette(data, 0, 0) === '#ff0000');
  ok('samples the right pixel at fx=1', samplePalette(data, 1, 0) === '#0000ff');
  ok('clamps out-of-range coords', samplePalette(data, 2, 5) === '#0000ff');
}

console.log(`\n${pass}/${pass + fail} player checks passed`);
process.exit(fail ? 1 : 0);
