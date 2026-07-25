/**
 * The shared document-modal shell for the About and Manual screens: the `steel.webp`
 * <Modal> (dialog.bmp frame) with a title + subtitle head, a scrollable body of
 * localised sections (heading / wrapped paragraphs / bullets), and a bottom Back button.
 * Callers pass the section list from their own locale table; any trailing `children`
 * (About's StatsPanel) render after the sections, inside the same scroll host.
 */
import type {ComponentChildren} from 'preact';
import type {AboutSection} from '../i18n';
import {backToMenu} from './store';
import {BmpText} from './BmpText';
import {BmpParagraph} from './BmpParagraph';
import {ClassicScrollbar} from './ClassicScrollbar';
import {Modal} from './Modal';
import {ModalButton} from './ModalButton';

export function SectionedDoc({
  title,
  subtitle,
  sections,
  back,
  children,
}: {
  title: string;
  subtitle: string;
  sections: AboutSection[];
  back: string;
  children?: ComponentChildren;
}) {
  return (
    <Modal backdrop="steel" width="min(680px, 92vw)" maxHeight="86vh" class="about-card">
      <div class="about-head">
        <BmpText font="bazouk-28" text={title} />
      </div>
      <div class="about-sub">
        <BmpText font="beijing-16-out" text={subtitle} />
      </div>
      <ClassicScrollbar class="about-body">
        {sections.map((sec, i) => (
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
        {children}
      </ClassicScrollbar>
      <ModalButton label={back} onClick={backToMenu} class="about-back" />
    </Modal>
  );
}
