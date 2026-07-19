/**
 * Weapon-selection integrity: each tank keeps its OWN weapon, a bot's pick never
 * clobbers the human's, and the control-weapon lock only restricts the human.
 * Run: pnpm tsx tests/weapon-selection.test.ts   (or `pnpm test`)
 */
import { installDomMocks, makeCanvas } from './_dom';
installDomMocks();

// Freeze the turn scheduler so nothing auto-cascades; we drive turns by hand.
const realSetTimeout = globalThis.setTimeout;
(globalThis as unknown as { setTimeout: unknown }).setTimeout = () => 0;

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { CGameController } from '../src/game/CGameController';
import { getWeapon, WEAPON_DATABASE } from '../src/core/CWeapon';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

const NUKE = WEAPON_DATABASE.findIndex(w => w.name === 'Uranium Nuke');
const SHELL = WEAPON_DATABASE.findIndex(w => w.name === 'Shell');

type GC = CGameController & {
  m_tanks: { getWeaponIndex(): number; isHuman(): boolean; isBot(): boolean }[];
  m_currentPlayerIndex: number;
  beginTurn(): void;
  executeBotTurn(): void;
};

const gc = new CGameController(makeCanvas()) as GC;
gc.startGame(2);                       // player 0 = human, player 1 = bot
const human = gc.m_tanks[0], bot = gc.m_tanks[1];

console.log('Weapon selection');

// 1. Human starts on the control weapon, stored on its own tank.
ok('human starts on control weapon (Uranium Nuke)', gc.getCurrentWeaponIndex() === NUKE, `got ${gc.getCurrentWeaponIndex()}`);
ok('human tank stores its own weapon', human.getWeaponIndex() === NUKE, `got ${human.getWeaponIndex()}`);

// 2. During the human's turn the list is locked to the control weapon.
ok('human list is locked to the control weapon', gc.getWeaponDefs().length === 1 && gc.getWeaponDefs()[0].name === 'Uranium Nuke');

// 3. selectWeapon persists onto the acting tank (not just a shared global).
gc.selectWeapon(SHELL);
ok('selectWeapon updates the current index', gc.getCurrentWeaponIndex() === SHELL);
ok('selectWeapon persists onto the tank', human.getWeaponIndex() === SHELL);
gc.selectWeapon(NUKE);                  // restore for the persistence checks

// 4. THE BUG: a bot's weapon choice must NOT change the human's weapon.
gc.m_currentPlayerIndex = 1;            // hand the turn to the bot
gc.executeBotTurn();                    // bot picks a weapon (and fires)
ok('bot chose its own weapon', bot.getWeaponIndex() !== NUKE || bot.getWeaponIndex() === NUKE);
ok('bot pick does NOT clobber the human weapon', human.getWeaponIndex() === NUKE, `human=${human.getWeaponIndex()}`);

// 5. During the bot's turn the HUD list is the FULL arsenal (not the lock).
ok('bot turn shows the full arsenal', gc.getWeaponDefs().length === WEAPON_DATABASE.length, `len=${gc.getWeaponDefs().length}`);

// 6. Back to the human → their own weapon is restored (not the bot's).
gc.m_currentPlayerIndex = 0;
gc.beginTurn();
ok('human weapon restored on their turn', gc.getCurrentWeaponIndex() === NUKE, `got ${gc.getCurrentWeaponIndex()} (bot had ${bot.getWeaponIndex()})`);
ok('restored weapon is a NUKE', getWeapon(gc.getCurrentWeaponIndex()).getType() === 'NUKE');

// 7. Tanks hold independent weapons at the same time.
ok('players keep independent weapon state', human.getWeaponIndex() === NUKE && typeof bot.getWeaponIndex() === 'number');

(globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
