/**
 * Battle Heroes — the "High Scores" hall of fame. A full steel-plate screen (click
 * anywhere to return) with the game's title, a Top-10 board, and a medal footer.
 *
 * Which board shows follows the current Game Type (as in the original): Points/Rounds
 * shows the Score board, Deathmatch the Kills board. The footer draws the local
 * player's battles won / lost and a place-value stack of medals for the wins — the
 * hundreds, tens and ones digits each rendered as that denomination's badge bitmap
 * (gui/battle won 100 / 10 / (1)).
 */
import {backToMenu} from './store';
import {heroData, type HeroEntry} from './highscoresStore';
import {strings} from '../i18n';
import {gameSettings as S} from './settingsValues';
import {BmpText} from './BmpText';
import {BattleMedals} from './BattleMedals';

function Board({entries, valueHeader}: {entries: HeroEntry[]; valueHeader: string}) {
  const s = strings.value;
  if (entries.length === 0) {
    return (
      <div class="hs-empty">
        <BmpText font="beijing-16-out" text={s.heroesEmpty} />
      </div>
    );
  }
  return (
    <div class="hs-table">
      <div class="hs-row hs-head">
        <BmpText font="beijing-20-out" text={s.heroesCallsign} />
        <BmpText font="beijing-20-out" text={valueHeader} />
      </div>
      {entries.map((e, i) => (
        <div key={i} class="hs-row">
          <BmpText font="beijing-16-out" text={`${i + 1}. ${e.name}`} />
          <BmpText font="beijing-16-out" text={String(e.value)} />
        </div>
      ))}
    </div>
  );
}

export function HighScores() {
  const s = strings.value;
  const d = heroData.value;
  // Points/Rounds (game type 0) shows the Score board; Deathmatch the Kills board.
  const pointsMode = S.gameType() === 0;
  const entries = pointsMode ? d.score : d.kills;
  const valueHeader = pointsMode ? s.heroesScore : s.heroesKills;

  return (
    <div class="highscores" onClick={backToMenu}>
      <div class="hs-title">
        <BmpText font="bazouk-28" text={s.heroesTitle} />
      </div>

      <Board entries={entries} valueHeader={valueHeader} />

      <BattleMedals />

      <div class="hs-prompt">
        <BmpText font="beijing-16-out" text={s.heroesPrompt} />
      </div>
    </div>
  );
}
