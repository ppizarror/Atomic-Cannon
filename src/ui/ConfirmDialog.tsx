/**
 * The yes/no confirmation card — the guard in front of anything that REPLACES this device's data
 * (Reset All, and Sync's link / download / desync). One card, so a destructive action can't ship
 * with a dialog that looks or behaves subtly differently from its neighbours.
 *
 * A backdrop click cancels, matching every other <Modal> in the game.
 */
import {BmpText} from './BmpText';
import {BmpParagraph} from './BmpParagraph';
import {Modal} from './Modal';
import {ModalButton} from './ModalButton';

export function ConfirmDialog({
  title,
  body,
  yes,
  no,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  yes: string;
  no: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal backdrop="scrim" onClose={onCancel} class="confirm-card">
      <div class="confirm-title">
        <BmpText font="bazouk-28" text={title} />
      </div>
      <BmpParagraph class="confirm-body" font="beijing-16-out" text={body} />
      <div class="confirm-buttons">
        <ModalButton label={yes} onClick={onConfirm} />
        <ModalButton label={no} onClick={onCancel} />
      </div>
    </Modal>
  );
}
