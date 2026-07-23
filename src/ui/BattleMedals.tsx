/**
 * The "Battles Won / Lost" footer + medal stack — the local player's cumulative
 * record, drawn both on the Battle Heroes (High Scores) screen and on the war-over
 * victory standings (in the original this is one shared component, shown on the
 * standings only when the local human wins the war).
 *
 * The medal stack is place-value: `won/100` big medals, then the tens digit as star
 * badges, then the ones digit as pips — each denomination on its own centered row,
 * from the `gui/battle won 100 / 10 / (1).bmp` badges (black keyed out).
 */
import {loadUiBmp} from './store';
import {heroData} from './highscoresStore';
import {strings} from '../i18n';
import {BmpText} from './BmpText';
import {useAsyncImage} from './useAsyncImage';

const MEDALS = {
  hundreds: 'gui/battle won 100.bmp',
  tens: 'gui/battle won 10.bmp',
  ones: 'gui/battle won.bmp',
} as const;

function MedalRow({src, count}: {src: string; count: number}) {
  if (count <= 0 || !src) return null;
  return (
    <div class="hs-medal-row">
      {Array.from({length: count}, (_, i) => (
        <img key={i} class="hs-medal" src={src} alt="" />
      ))}
    </div>
  );
}

function MedalStack({won}: {won: number}) {
  const h100 = useAsyncImage(() => loadUiBmp(MEDALS.hundreds, 'black'), []);
  const h10 = useAsyncImage(() => loadUiBmp(MEDALS.tens, 'black'), []);
  const h1 = useAsyncImage(() => loadUiBmp(MEDALS.ones, 'black'), []);
  if (won <= 0) return null;
  return (
    <div class="hs-medals">
      <MedalRow src={h100} count={Math.floor(won / 100)} />
      <MedalRow src={h10} count={Math.floor((won % 100) / 10)} />
      <MedalRow src={h1} count={won % 10} />
    </div>
  );
}

export function BattleMedals() {
  const d = heroData.value;
  const record = strings.value.heroesRecord
    .replace('{won}', String(d.won))
    .replace('{lost}', String(d.lost));
  return (
    <div class="battle-medals">
      <div class="hs-record">
        <BmpText font="beijing-16-out" text={record} />
      </div>
      <MedalStack won={d.won} />
    </div>
  );
}
