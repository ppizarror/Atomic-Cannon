/**
 * Key-binding model — the set of player actions the "Customize Controls" editor
 * rebinds, and the lookup that turns a pressed key into an action at play time.
 *
 * The engine speaks DOM `KeyboardEvent.code` (physical-key identifiers like `KeyQ`
 * or `ArrowLeft`), so each action carries its default as a `code`. A binding is a
 * single key per action (no modifiers, no combos): the live map is one `code` per
 * action id, and `resolveAction` scans it to find which action a pressed key drives
 * — the same "compare the pressed key against each stored binding" approach the
 * engine's input dispatch uses.
 *
 * The full action list is shown and rebindable in the editor. Every listed action — the
 * artillery controls (fire / aim / power / weapon cycle / exit) and the Chat Taunt key —
 * is wired into the input loop. (Full Screen lives in Settings, not as a keybind.)
 */

export type ActionId =
  'fire' | 'prevWeapon' | 'nextWeapon' | 'aimLeft' | 'powerUp' | 'aimRight' | 'powerDown' | 'exit' | 'taunt';

export interface ActionDef {
  id: ActionId;
  /** DOM KeyboardEvent.code the action binds to by default. */
  defaultCode: string;
  /** Actions the gameplay input loop actually reads (the rest are shell/cosmetic). */
  gameplay: boolean;
}

/** The bindable actions in editor display order, with their default keys. The player-facing action
 *  NAME is not stored here (core holds no copy) — it comes from i18n `editors.controls.actions[id]`. */
export const ACTIONS: ActionDef[] = [
  {id: 'fire', defaultCode: 'Space', gameplay: true},
  {id: 'prevWeapon', defaultCode: 'KeyQ', gameplay: true},
  {id: 'nextWeapon', defaultCode: 'KeyA', gameplay: true},
  {id: 'aimLeft', defaultCode: 'ArrowLeft', gameplay: true},
  {id: 'powerUp', defaultCode: 'ArrowUp', gameplay: true},
  {id: 'aimRight', defaultCode: 'ArrowRight', gameplay: true},
  {id: 'powerDown', defaultCode: 'ArrowDown', gameplay: true},
  {id: 'exit', defaultCode: 'Escape', gameplay: true},
  {id: 'taunt', defaultCode: 'Enter', gameplay: false},
];

/** A binding map: one key `code` per action id ('' = unassigned). */
export type Bindings = Record<ActionId, string>;

/** The factory-default bindings (every action on its `defaultCode`). */
export function defaultBindings(): Bindings {
  const b = {} as Bindings;
  for (const a of ACTIONS) b[a.id] = a.defaultCode;
  return b;
}

/**
 * Which action a pressed key drives, or null if the key is bound to nothing.
 * Scans the binding map so a rebound key routes to its new action immediately.
 */
export function resolveAction(bindings: Bindings, code: string): ActionId | null {
  if (!code) return null;
  for (const a of ACTIONS) {
    if (bindings[a.id] === code) return a.id;
  }
  return null;
}

/**
 * Human-readable name for a key `code`, for the editor's "Button" column.
 * Mirrors the engine's key-name table where it has a friendly label, and falls
 * back to a trimmed form of the raw code otherwise.
 */
export function keyName(code: string): string {
  if (!code) return ''; // unassigned — the editor substitutes the localised "Unassigned" label
  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Tab: 'Tab',
    CapsLock: 'Capslock',
    Delete: 'Delete',
    PageDown: 'Page Down',
    ArrowLeft: 'Left',
    ArrowUp: 'Up',
    ArrowRight: 'Right',
    ArrowDown: 'Down',
    NumpadSubtract: 'Numpad -',
  };
  if (named[code]) return named[code];
  // KeyQ → Q, Digit1 → 1, F9 → F9, otherwise the code itself.
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1];
  return code;
}
