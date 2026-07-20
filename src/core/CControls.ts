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
 * The full action list is shown and rebindable in the editor. Only the artillery
 * actions (fire / aim / power / weapon cycle / exit) are wired into gameplay input;
 * the rest (screenshot, tutorial, full screen, taunt, minimize) are surfaced for
 * completeness but handled by the browser/app shell, so binding them is cosmetic.
 */

export type ActionId =
  | 'fire'
  | 'prevWeapon'
  | 'nextWeapon'
  | 'aimLeft'
  | 'powerUp'
  | 'aimRight'
  | 'powerDown'
  | 'exit'
  | 'minimize'
  | 'screenshot'
  | 'tutorial'
  | 'fullscreen'
  | 'taunt';

export interface ActionDef {
  id: ActionId;
  label: string;
  /** DOM KeyboardEvent.code the action binds to by default. */
  defaultCode: string;
  /** Actions the gameplay input loop actually reads (the rest are shell/cosmetic). */
  gameplay: boolean;
}

/** The bindable actions in editor display order, with their default keys. */
export const ACTIONS: ActionDef[] = [
  {id: 'fire', label: 'Fire cannon', defaultCode: 'Space', gameplay: true},
  {id: 'prevWeapon', label: 'Previous weapon', defaultCode: 'KeyQ', gameplay: true},
  {id: 'nextWeapon', label: 'Next weapon', defaultCode: 'KeyA', gameplay: true},
  {id: 'aimLeft', label: 'Left', defaultCode: 'ArrowLeft', gameplay: true},
  {id: 'powerUp', label: 'Up', defaultCode: 'ArrowUp', gameplay: true},
  {id: 'aimRight', label: 'Right', defaultCode: 'ArrowRight', gameplay: true},
  {id: 'powerDown', label: 'Down', defaultCode: 'ArrowDown', gameplay: true},
  {id: 'exit', label: 'Exit', defaultCode: 'Escape', gameplay: true},
  {id: 'minimize', label: 'Minimize', defaultCode: 'NumpadSubtract', gameplay: false},
  {id: 'screenshot', label: 'Screen shot', defaultCode: 'F9', gameplay: false},
  {id: 'tutorial', label: 'Show tutorial', defaultCode: 'F1', gameplay: false},
  {id: 'fullscreen', label: 'Toggle full screen', defaultCode: 'F11', gameplay: false},
  {id: 'taunt', label: 'Chat Taunt', defaultCode: 'Enter', gameplay: false},
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
  if (!code) return 'Unassigned';
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
