/**
 * Game Content — the Weapons / Landscapes enable lists actually affect play: the
 * default-disabled secret weapons, the enabled-set gating the arsenal / depot /
 * auto-buy, and the landscape picker honouring the enabled landscapes.
 * Run: pnpm tsx tests/content.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, getDefaultWeaponIndex} from '../src/core/CWeapon';
import {GameContent, weaponEnabled, landEnabled} from '../src/core/CGameContent';
import {weaponsOff as pendingWeaponsOff} from '../src/ui/contentStore';
import landData from '../src/data/land.json';

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

const LAND_COUNT = (landData as unknown[]).length;
const STAPLE = getDefaultWeaponIndex();

console.log('Game Content');

// 1. Default selection: the secret "Organic" weapons start disabled, others enabled.
{
  const organic = WEAPON_DATABASE.findIndex(w => w.type === 'Organic');
  ok('an Organic weapon exists', organic >= 0);
  ok('secret Organic weapon defaults disabled', pendingWeaponsOff.value.has(organic));
  ok('the staple (Shell) defaults enabled', !pendingWeaponsOff.value.has(STAPLE));
  ok('there are exactly 4 default-disabled weapons', pendingWeaponsOff.value.size === 4);
}

// 2. weaponEnabled / landEnabled reflect the active GameContent sets.
{
  GameContent.weaponsOff = new Set([5]);
  GameContent.landsOff = new Set([2]);
  ok('disabled weapon reads disabled', !weaponEnabled(5) && weaponEnabled(0));
  ok('disabled landscape reads disabled', !landEnabled(2) && landEnabled(0));
}

// 3. The arsenal (getWeaponDefs) hides disabled weapons but always keeps the staple.
{
  const other = WEAPON_DATABASE.find(w => w.index !== STAPLE)!.index;
  GameContent.weaponsOff = new Set([other, STAPLE]); // even the staple "disabled"
  const gc = new CGameController(makeCanvas());
  const defs = gc.getWeaponDefs();
  ok('disabled weapon absent from the arsenal', !defs.some(w => w.index === other));
  ok('staple stays available even if disabled', defs.some(w => w.index === STAPLE));
}

// 4. The landscape picker only chooses enabled landscapes.
{
  GameContent.landsOff = new Set(
    Array.from({length: LAND_COUNT}, (_, i) => i).filter(i => i !== 7),
  );
  const gc = new CGameController(makeCanvas());
  const pick = gc as unknown as {pickLandscapeIndex(): number};
  let onlySeven = true;
  for (let k = 0; k < 60; k++) if (pick.pickLandscapeIndex() !== 7) onlySeven = false;
  ok('landscape pick honours the enabled set', onlySeven);
  GameContent.landsOff = new Set();
}

// 5. Auto-buy skips disabled weapons (all off → buys nothing).
{
  GameContent.weaponsOff = new Set(WEAPON_DATABASE.map((_, i) => i));
  const gc = new CGameController(makeCanvas());
  gc.setStartCredits(50000);
  gc.startGame(2);
  gc.autoBuyWeapons();
  const owned = gc.getOwnedCounts();
  const finiteBought = owned.filter(c => c > 0 && Number.isFinite(c)).length;
  ok('auto-buy buys nothing when every weapon is disabled', finiteBought === 0, `bought=${finiteBought}`);
  GameContent.weaponsOff = new Set();
}

console.log(`\n${pass}/${pass + fail} content checks passed`);
process.exit(fail ? 1 : 0);
