/**
 * Manual / How-to-play screen — the main-menu "Manual" entry. A readable port of the
 * original atomic-help.html: gameplay, story, controls, weapons, landscapes, weather,
 * computer AI, and gameplay tips. Rendered in the game's bitmap fonts over the
 * `steel.webp` backdrop inside the shared <SectionedDoc> (same card chrome as About).
 *
 * Prose lives in the active locale's `manual` string table and each paragraph is wrapped
 * to the panel width at draw time (BmpParagraph), so there are no hard-coded line breaks
 * and translations re-flow on their own. Text is ASCII-only (the bitmap fonts cover
 * ASCII 33..126 — no arrows / en-dash / smart quotes).
 */
import {strings} from '../i18n';
import {SectionedDoc} from './SectionedDoc';

export function Manual() {
  const s = strings.value.manual;
  return <SectionedDoc title={s.title} subtitle={s.subtitle} sections={s.sections} back={s.back} />;
}
