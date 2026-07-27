/**
 * Customize Controls — the key-binding model and store: factory defaults, the
 * pressed-key → action resolver, rebinding (with the old holder unassigned),
 * unassign, and reset-to-defaults.
 */
import {describe, it, expect} from 'vitest';

import {ACTIONS, defaultBindings, resolveAction, keyName} from '../src/core/CControls';
import {bindings, rebind, unassign, resetDefaults} from '../src/ui/controlsStore';

describe('Customize Controls', () => {
  it('default bindings match the registered actions', () => {
    const b = defaultBindings();
    expect(ACTIONS).toHaveLength(9);
    expect(b.fire).toBe('Space');
    expect(b.prevWeapon).toBe('KeyQ');
    expect(b.nextWeapon).toBe('KeyA');
    expect(b.aimLeft).toBe('ArrowLeft');
    expect(b.aimRight).toBe('ArrowRight');
  });

  it('resolves a pressed key to its action', () => {
    const b = defaultBindings();
    expect(resolveAction(b, 'Space')).toBe('fire');
    expect(resolveAction(b, 'ArrowUp')).toBe('powerUp');
    expect(resolveAction(b, 'KeyZ')).toBeNull(); // unbound
    expect(resolveAction(b, '')).toBeNull(); // empty code
  });

  it('every gameplay input-loop key resolves to its wired action', () => {
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
    for (const [code, id] of Object.entries(wired)) {
      expect(resolveAction(b, code)).toBe(id);
    }
  });

  it('rebinding moves a key and unassigns its previous holder', () => {
    resetDefaults();
    rebind('fire', 'KeyF'); // fire off Space onto F
    expect(resolveAction(bindings.value, 'KeyF')).toBe('fire');
    expect(resolveAction(bindings.value, 'Space')).toBeNull();

    // Steal aimLeft's key for fire → aimLeft is left unassigned (one key, one action).
    rebind('fire', 'ArrowLeft');
    expect(resolveAction(bindings.value, 'ArrowLeft')).toBe('fire');
    expect(bindings.value.aimLeft).toBe('');
  });

  it('unassign clears a single action', () => {
    resetDefaults();
    unassign('taunt');
    expect(bindings.value.taunt).toBe('');
    expect(resolveAction(bindings.value, 'Enter')).toBeNull();
  });

  it('reset restores every default', () => {
    rebind('fire', 'KeyF');
    resetDefaults();
    expect(bindings.value.fire).toBe('Space');
    expect(bindings.value.taunt).toBe('Enter');
  });

  it('renders friendly key names', () => {
    expect(keyName('KeyQ')).toBe('Q');
    expect(keyName('ArrowLeft')).toBe('Left');
    // An unbound action returns '' — the editor substitutes the localised "Unassigned" label.
    expect(keyName('')).toBe('');
  });
});
