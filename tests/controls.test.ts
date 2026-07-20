/**
 * Customize Controls — the key-binding model and store: factory defaults, the
 * pressed-key → action resolver, rebinding (with the old holder unassigned),
 * unassign, and reset-to-defaults.
 * Run: pnpm tsx tests/controls.test.ts   (or `pnpm test`)
 */
import {installDomMocks} from './_dom';

installDomMocks();

import {ACTIONS, defaultBindings, resolveAction, keyName} from '../src/core/CControls';
import {bindings, rebind, unassign, resetDefaults} from '../src/ui/controlsStore';

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

console.log('Customize Controls');

// 1. The default binding set matches the registered actions.
{
  const b = defaultBindings();
  ok('there are 13 bindable actions', ACTIONS.length === 13);
  ok('fire defaults to Space', b.fire === 'Space');
  ok('previous weapon defaults to Q', b.prevWeapon === 'KeyQ');
  ok('next weapon defaults to A', b.nextWeapon === 'KeyA');
  ok(
    'aim left/right default to the arrows',
    b.aimLeft === 'ArrowLeft' && b.aimRight === 'ArrowRight',
  );
}

// 2. The resolver maps a pressed key to its action.
{
  const b = defaultBindings();
  ok('Space resolves to fire', resolveAction(b, 'Space') === 'fire');
  ok('ArrowUp resolves to power up', resolveAction(b, 'ArrowUp') === 'powerUp');
  ok('an unbound key resolves to nothing', resolveAction(b, 'KeyZ') === null);
  ok('an empty code resolves to nothing', resolveAction(b, '') === null);
}

// 2b. Every action the gameplay input loop consumes resolves from its default key.
{
  const b = defaultBindings();
  const wired: Record<string, string> = {
    Space: 'fire',
    KeyQ: 'prevWeapon',
    KeyA: 'nextWeapon',
    ArrowLeft: 'aimLeft',
    ArrowRight: 'aimRight',
    ArrowUp: 'powerUp',
    ArrowDown: 'powerDown',
    Escape: 'exit',
  };
  let allWired = true;
  for (const [code, id] of Object.entries(wired)) {
    if (resolveAction(b, code) !== id) allWired = false;
  }
  ok('gameplay keys resolve to their wired actions', allWired);
}

// 3. Rebinding moves a key and unassigns whoever held it before.
{
  resetDefaults();
  rebind('fire', 'KeyF'); // fire off Space onto F
  ok('fire now resolves from F', resolveAction(bindings.value, 'KeyF') === 'fire');
  ok('Space no longer fires', resolveAction(bindings.value, 'Space') === null);

  // Steal aimLeft's key for fire → aimLeft is left unassigned (one key, one action).
  rebind('fire', 'ArrowLeft');
  ok('the stolen key drives its new action', resolveAction(bindings.value, 'ArrowLeft') === 'fire');
  ok('the previous holder is unassigned', bindings.value.aimLeft === '');
}

// 4. Unassign clears a single action.
{
  resetDefaults();
  unassign('taunt');
  ok('an unassigned action holds no key', bindings.value.taunt === '');
  ok('resolving its old key finds nothing', resolveAction(bindings.value, 'Enter') === null);
}

// 5. Reset restores every default.
{
  rebind('fire', 'KeyF');
  resetDefaults();
  ok(
    'reset restores the factory bindings',
    bindings.value.fire === 'Space' && bindings.value.taunt === 'Enter',
  );
}

// 6. Key names are friendly.
{
  ok('KeyQ shows as Q', keyName('KeyQ') === 'Q');
  ok('ArrowLeft shows as Left', keyName('ArrowLeft') === 'Left');
  ok('an empty binding shows as Unassigned', keyName('') === 'Unassigned');
}

console.log(`\n${pass}/${pass + fail} controls checks passed`);
process.exit(fail ? 1 : 0);
