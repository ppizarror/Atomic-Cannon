/**
 * Modal — the one framed dialog shared by Help, About and any pop-up card. Renders a
 * centered card on the game's `atomic/dialog.bmp` beveled metal frame (.dialog-frame),
 * over either a dim scrim (a pop-up over the current screen) or the steel plate
 * (a full screen of its own). A backdrop click calls `onClose` when provided; clicks
 * inside the card never bubble out to it.
 *
 * Every dialog wears the same dialog.bmp frame — route pop-up cards through here rather than
 * rolling a bespoke overlay + card per screen, which is how they drift visually apart.
 */
import type {ComponentChildren, JSX} from 'preact';

export function Modal({
  backdrop = 'scrim',
  onClose,
  width,
  maxHeight,
  class: cls,
  children,
}: {
  /** `scrim` dims the current screen; `steel` fills the viewport with the steel plate. */
  backdrop?: 'scrim' | 'steel';
  /** Backdrop-click handler. Omit for a full-screen modal that closes via its own button. */
  onClose?: () => void;
  width?: string;
  maxHeight?: string;
  /** Extra class on the card (per-dialog width/padding overrides live there). */
  class?: string;
  children: ComponentChildren;
}) {
  const style: JSX.CSSProperties = {};
  if (width) style.width = width;
  if (maxHeight) style.maxHeight = maxHeight;
  return (
    <div class={`overlay modal-overlay modal-${backdrop}`} onClick={onClose}>
      <div
        class={`modal-card dialog-frame ${cls ?? ''}`}
        style={style}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
