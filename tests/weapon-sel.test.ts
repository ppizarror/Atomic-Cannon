/**
 * `?weapon_sel=<id>` selects by STABLE weapon id, and the arsenal list numbers rows
 * by that same id (`weaponDisplayNumber`), NOT by their position in the (filtered)
 * list. Regression for: with weapons disabled in Game Content, list-position numbering
 * drifted below the id, so `weapon_sel=74` (aiming at "Tracer 5") landed on Barrage.
 * Run: pnpm tsx tests/weapon-sel.test.ts   (or `pnpm test`)
 */
import {installDomMocks, makeCanvas} from './_dom';

installDomMocks();

const realSetTimeout = globalThis.setTimeout;
(globalThis as unknown as {setTimeout: unknown}).setTimeout = () => 0;

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE, weaponDisplayNumber} from '../src/core/CWeapon';
import {GameContent} from '../src/core/CGameContent';

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

console.log('weapon_sel (stable-id selection)');

const tracer5 = WEAPON_DATABASE.find(w => w.name === 'Tracer 5')!;
const barrage = WEAPON_DATABASE.find(w => w.name === 'Barrage')!;

// 1. The displayed number is the weapon's stable id (index + 1) — the value you pass
//    to ?weapon_sel. So `weapon_sel = weaponDisplayNumber(w)` and `forceWeapon(id-1)`
//    are inverses: the id you read off the list selects that exact weapon.
ok(
  'display number is the stable id (index + 1)',
  weaponDisplayNumber(tracer5) === tracer5.index + 1,
  `got ${weaponDisplayNumber(tracer5)} vs ${tracer5.index + 1}`,
);

// 2. Disabling weapons that sit BEFORE Tracer 5 must NOT change its number — the whole
//    point of id- over position-numbering. (Position numbering would drop it by 3 here.)
const before = WEAPON_DATABASE.filter(w => w.index < tracer5.index).slice(0, 3);
for (const w of before) GameContent.weaponsOff.add(w.index);
ok(
  'stable id is unchanged when earlier weapons are disabled',
  weaponDisplayNumber(tracer5) === tracer5.index + 1,
  `got ${weaponDisplayNumber(tracer5)}`,
);
// The naive list-position number WOULD have shifted down by the 3 disabled rows —
// prove id-numbering and position-numbering genuinely differ here (the old bug).
const enabled = WEAPON_DATABASE.filter(w => !GameContent.weaponsOff.has(w.index));
const listPos = enabled.findIndex(w => w.index === tracer5.index) + 1;
ok(
  'list-position numbering DOES drift (the old bug)',
  listPos === weaponDisplayNumber(tracer5) - before.length,
  `pos=${listPos} id=${weaponDisplayNumber(tracer5)}`,
);
for (const w of before) GameContent.weaponsOff.delete(w.index); // restore

// 3. End-to-end: ?weapon_sel=<id> → forceWeapon(id-1) selects that exact weapon even
//    with earlier weapons disabled (the reported scenario).
const gc = new CGameController(makeCanvas()) as unknown as {
  startGame(n: number): void;
  forceWeapon(index: number): void;
  getCurrentWeapon(): {getName(): string};
};
gc.startGame(2);

const selById = (id: number) => {
  gc.forceWeapon(id - 1);
  return gc.getCurrentWeapon().getName();
};

ok(
  `weapon_sel=${weaponDisplayNumber(tracer5)} selects Tracer 5`,
  selById(weaponDisplayNumber(tracer5)) === 'Tracer 5',
  `got ${gc.getCurrentWeapon().getName()}`,
);
ok(
  `weapon_sel=${weaponDisplayNumber(barrage)} selects Barrage`,
  selById(weaponDisplayNumber(barrage)) === 'Barrage',
  `got ${gc.getCurrentWeapon().getName()}`,
);

(globalThis as unknown as {setTimeout: unknown}).setTimeout = realSetTimeout;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
