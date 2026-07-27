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
import {MenuScreen} from './MenuScreen';

function Board({entries, valueHeader}: {entries: HeroEntry[]; valueHeader: string}) {
  const s = strings.value.heroes;
  if (entries.length === 0) {
    return (
      <div class="hs-empty">
        <BmpText font="beijing-16-out" text={s.empty} />
      </div>
    );
  }
  return (
    <div class="hs-table">
      <div class="hs-row hs-head">
        <BmpText font="beijing-20-out" text={s.callsign} />
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
  const s = strings.value.heroes;
  const d = heroData.value;
  // Points/Rounds (game type 0) shows the Score board; Deathmatch the Kills board.
  const pointsMode = S.gameType() === 0;
  const entries = pointsMode ? d.score : d.kills;
  const valueHeader = pointsMode ? s.score : s.kills;

  return (
    <MenuScreen backdrop="steel" subtitle={s.prompt} onClick={backToMenu} class="menu-tap">
      <div class="hs-content">
        <div class="hs-title">
          <BmpText font="bazouk-28" text={s.title} />
        </div>

        <Board entries={entries} valueHeader={valueHeader} />

        <BattleMedals />
      </div>
    </MenuScreen>
  );
}
