/**
 * About / credits screen. Renders the localised About document (story, game notes,
 * original credits, and this port) entirely in the game's bitmap fonts over the
 * `steel.webp` backdrop, inside the shared <SectionedDoc> (same dialog chrome as Help
 * and the Manual). Prose comes from the active locale's string table and each paragraph
 * is wrapped to the panel width at draw time (BmpParagraph), so there are no hard-coded
 * line breaks and translations re-flow on their own. About appends a live StatsPanel
 * section after the prose.
 */
import {strings} from '../i18n';
import {BmpText} from './BmpText';
import {SectionedDoc} from './SectionedDoc';
import {StatsPanel} from './StatsPanel';

export function About() {
  const s = strings.value.about;
  return (
    <SectionedDoc title={s.title} subtitle={s.subtitle} sections={s.sections} back={s.back}>
      <section class="about-section">
        <div class="about-sec-head">
          <BmpText font="beijing-20-out" text={s.stats.title} />
        </div>
        <StatsPanel />
      </section>
    </SectionedDoc>
  );
}
