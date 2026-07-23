/**
 * About / credits screen. Renders the localised About document (story, game notes,
 * original credits, and this port) entirely in the game's bitmap fonts over the
 * `steel.webp` backdrop, inside the shared <Modal> (dialog.bmp frame) — the same
 * dialog chrome as Help. Prose comes from the active locale's string table and each
 * paragraph is wrapped to the panel width at draw time (BmpParagraph), so there are
 * no hard-coded line breaks and translations re-flow on their own.
 */
import {strings} from '../i18n';
import {backToMenu} from './store';
import {BmpText} from './BmpText';
import {BmpParagraph} from './BmpParagraph';
import {ClassicScrollbar} from './ClassicScrollbar';
import {Modal} from './Modal';
import {ModalButton} from './ModalButton';

export function About() {
  const s = strings.value.about;
  return (
    <Modal backdrop="steel" width="min(680px, 92vw)" maxHeight="86vh" class="about-card">
      <div class="about-head">
        <BmpText font="bazouk-28" text={s.title} />
      </div>
      <div class="about-sub">
        <BmpText font="beijing-16-out" text={s.subtitle} />
      </div>
      <ClassicScrollbar class="about-body">
        {s.sections.map((sec, i) => (
          <section key={i} class="about-section">
            {sec.heading && (
              <div class="about-sec-head">
                <BmpText font="beijing-20-out" text={sec.heading} />
              </div>
            )}
            {sec.body?.map((p, j) => (
              <BmpParagraph key={`p${j}`} class="about-para" font="beijing-16-out" text={p} />
            ))}
            {sec.bullets?.map((b, j) => (
              <div key={`b${j}`} class="about-bullet">
                <BmpText font="beijing-16-out" text="-" />
                <BmpParagraph class="about-para" font="beijing-16-out" text={b} />
              </div>
            ))}
          </section>
        ))}
      </ClassicScrollbar>
      <ModalButton label={s.back} onClick={backToMenu} class="about-back" />
    </Modal>
  );
}
