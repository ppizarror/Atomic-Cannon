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
import {strings, fmt} from '../i18n';
import {ACTIONS, keyName} from '../core/CControls';
import {bindings} from './controlsStore';
import {SectionedDoc} from './SectionedDoc';

export function Manual() {
  const s = strings.value.manual;
  // Resolve the Controls section's `{actionId}` placeholders to the player's LIVE key bindings (the
  // same source Customize Controls reads), so the manual always matches the editor instead of a
  // hardcoded default — e.g. a taunt rebound to "2" reads "2" here, not "Enter".
  const b = bindings.value;
  const unassigned = strings.value.editors.controls.unassigned;
  const keys: Record<string, string> = {};
  for (const a of ACTIONS) keys[a.id] = keyName(b[a.id]) || unassigned;
  const sections = s.sections.map(sec =>
    sec.bullets ? {...sec, bullets: sec.bullets.map(line => fmt(line, keys))} : sec,
  );
  return <SectionedDoc title={s.title} subtitle={s.subtitle} sections={sections} back={s.back} />;
}
