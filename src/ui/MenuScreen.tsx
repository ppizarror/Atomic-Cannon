/**
 * MenuScreen — the ONE shared full-screen menu chrome. It owns the three things every
 * list-style menu screen needs so they can never drift again:
 *   • the full-screen backdrop plate (`backdrop`: dim title / plain title / steel),
 *   • a ClassicScrollbar scroll host (so long lists scroll instead of clipping on a
 *     short viewport — the game's custom bar, never the native one), and
 *   • the bottom-centre hover subtitle.
 *
 * Callers pass their body — a `.menu-list …` (with the `useMenuNav` ref) — as children,
 * plus the already-resolved subtitle text. `scroll={false}` opts out of the scroll host
 * for the rare screen that manages its own layout.
 */
import type {ComponentChildren} from 'preact';
import {BmpText} from './BmpText';
import {ClassicScrollbar} from './ClassicScrollbar';

// Backdrop plate: 'dim'/'plain' title plate, brushed 'steel', or 'none' (transparent —
// for a screen that overlays the live battle scene, e.g. the between-battles standings).
type Backdrop = 'dim' | 'plain' | 'steel' | 'none';

export function MenuScreen({
  subtitle = '',
  spacing,
  scroll = true,
  backdrop = 'dim',
  class: cls,
  onClick,
  children,
}: {
  subtitle?: string;
  spacing?: number;
  scroll?: boolean;
  backdrop?: Backdrop;
  class?: string;
  /** Whole-screen click (the "click anywhere to return/advance" info screens). */
  onClick?: () => void;
  children: ComponentChildren;
}) {
  const body = scroll ? (
    <ClassicScrollbar class="settings-scroll">{children}</ClassicScrollbar>
  ) : (
    children
  );
  return (
    <div class={`settings-screen bg-${backdrop}${cls ? ' ' + cls : ''}`} onClick={onClick}>
      {body}
      <div class="settings-subtitle">
        {subtitle ? <BmpText font="beijing-16-out" text={subtitle} spacing={spacing} /> : null}
      </div>
    </div>
  );
}
