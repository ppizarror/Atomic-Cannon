/**
 * Quit-confirmation dialog — shown when the browser Back button (or a swipe-back) would abandon a
 * live battle. The router already undid that navigation and put up this modal (see the popstate
 * guard in store); here the player decides: Quit tears the match down and returns to the menu, while
 * Stay / a backdrop click / Escape dismisses it and keeps playing.
 *
 * The solo-vs-net quit split mirrors the pause menu's Quit (see PauseMenu): a networked battle must
 * also leave the room so the peer isn't stranded, whereas a solo battle just drops to the menu.
 */
import {showQuitConfirm, cancelQuitBattle, goToMenu, uiClick} from './store';
import {netState, leaveMatch} from './networkStore';
import {Modal} from './Modal';
import {ModalButton} from './ModalButton';
import {BmpText} from './BmpText';
import {strings} from '../i18n';

export function QuitConfirm() {
  if (!showQuitConfirm.value) return null;
  const q = strings.value.quitConfirm;
  const inNetMatch = netState.value.phase === 'playing';
  const onConfirm = () => {
    showQuitConfirm.value = false;
    uiClick();
    if (inNetMatch) leaveMatch();
    else goToMenu();
  };
  return (
    <Modal onClose={cancelQuitBattle} class="quit-confirm">
      <div class="quit-confirm-title">
        <BmpText font="beijing-16-out" text={q.title} />
      </div>
      <div class="quit-confirm-msg">
        <BmpText font="arial-14-out" text={q.line1} />
      </div>
      <div class="quit-confirm-msg">
        <BmpText font="arial-14-out" text={q.line2} />
      </div>
      <div class="quit-confirm-btns">
        <ModalButton label={q.confirm} onClick={onConfirm} />
        <ModalButton label={q.cancel} onClick={cancelQuitBattle} />
      </div>
    </Modal>
  );
}
