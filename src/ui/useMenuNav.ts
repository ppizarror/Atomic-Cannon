/**
 * ONE keyboard convention for every menu list — the plain button lists (main menu, the
 * "Game Menu" pause list, the Settings root) AND the `< Label … Value >` widget pages
 * (Play setup, the Settings option pages). The game assumes the MOUSE by default —
 * nothing is "selected" until the player first presses an arrow; from then on Up/Down
 * (Home/End) move a keyboard highlight between ROWS. Enter/Space fire an action row
 * (native <button>); on a value row, Left/Right change the value — but that part lives
 * in <WidgetRow>, which owns its own semantics. This hook's one job is moving focus
 * from row to row; a "row" is any `.menu-btn` (a plain button, a BigButton, a nav row,
 * or a value-row <div>). The highlight is `.menu-btn:focus-visible` (see hud.css),
 * which only paints for keyboard focus, so a mouse user never sees a lingering select.
 *
 * A value row is a <div>, not natively focusable, so the hook gives it `tabindex=-1`
 * on demand — that keeps WidgetRow's markup unchanged and means any future non-button
 * `.menu-btn` row becomes navigable for free.
 *
 * Pass a stable `navKey` and the menu REMEMBERS its selection: leave Settings for a
 * sub-page and come back and the highlight is where you left it. The position is only
 * restored while the player is still on the keyboard — a mouse click (anywhere) reverts
 * to "assume mouse", so we never force a stale selection back onto a pointer user.
 *
 * Attach the returned ref to the `.menu-list` container. The listener lives on
 * `document` (capture phase) because before the first arrow no menu item is focused,
 * so a container-scoped handler would never see the keystroke; capture also lets it
 * beat the global gameplay keydown in main.tsx (Up/Down are power keys in battle, and
 * the pause menu sits on the battle screen). A module-level stack makes only the
 * top-most mounted menu respond, so a stacked menu never fights the one beneath it.
 */
import {useEffect, useRef} from 'preact/hooks';
import {uiMenuHover} from './store';

const stack: HTMLElement[] = [];

// Remembered selection per menu (by navKey), and whether the player is currently
// driving by keyboard. `keyboardMode` gates restore so a menu reopened after a mouse
// click starts fresh (mouse-assumed) rather than snapping focus back.
const lastIndex = new Map<string, number>();
let keyboardMode = false;
let pointerHooked = false;

// Lazy (first useEffect, so never at import time — the test env has no document): any
// pointer press means the player is back on the mouse; stop auto-restoring selections.
function hookPointer(): void {
  if (pointerHooked) return;
  pointerHooked = true;
  document.addEventListener(
    'pointerdown',
    () => {
      keyboardMode = false;
    },
    true,
  );
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// All navigable rows of a menu, in order: any `.menu-btn` that isn't a disabled button.
function rowsOf(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.menu-btn:not(:disabled)'));
}

// Focus a row, making a non-button row (a value-row <div>) focusable on demand.
function focusRow(row: HTMLElement): void {
  if (row.tagName !== 'BUTTON' && !row.hasAttribute('tabindex')) row.tabIndex = -1;
  row.focus();
}

export function useMenuNav<T extends HTMLElement = HTMLDivElement>(navKey?: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    hookPointer();
    stack.push(el);

    // Returning to this menu still on the keyboard? Put the highlight back where it was.
    if (navKey != null && keyboardMode) {
      const idx = lastIndex.get(navKey);
      if (idx != null) {
        const rows = rowsOf(el);
        if (rows.length) focusRow(rows[Math.min(idx, rows.length - 1)]);
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return; // only the top-most menu drives
      const key = e.key;
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
      if (isTypingTarget(e.target)) return; // a field inside the menu owns its arrows

      const items = rowsOf(el);
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation(); // keep Up/Down off the gameplay handler (power keys in battle)

      // Continue from the focused item; if the player was on the mouse, start from the
      // hovered one so the highlight lands where their pointer already is.
      let cur = items.indexOf(document.activeElement as HTMLElement);
      if (cur < 0) {
        const hovered = el.querySelector<HTMLElement>('.menu-btn:hover');
        cur = hovered ? items.indexOf(hovered) : -1;
      }

      const last = items.length - 1;
      const next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? last
            : key === 'ArrowDown'
              ? cur < 0
                ? 0
                : (cur + 1) % items.length
              : cur < 0
                ? last
                : (cur - 1 + items.length) % items.length;

      if (next !== cur) uiMenuHover(); // same blip a pointer hover plays
      keyboardMode = true;
      if (navKey != null) lastIndex.set(navKey, next);
      focusRow(items[next]);
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(el);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
  return ref;
}
