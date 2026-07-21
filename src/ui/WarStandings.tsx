/**
 * Between-battles standings — the "X is winning the war" screen. Shown over the frozen
 * battle scene when a battle ends (the HUD is hidden): a Victory/Defeat banner, the
 * title, the "Battle N of M completed" subtitle, the per-team stats table, the
 * win-condition line, and a click-anywhere prompt. Clicking advances to the next battle
 * (or the menu once the war is over). The winner flag + taunt bubble are drawn in the
 * scene, next to the winning tank.
 */
import {BmpText} from './BmpText';
import {warStandings, advanceWar} from './store';
import type {WarTeamRow} from '../game/CGameController';

const pct = (v: number) => `${Math.round(v)}%`;

// Every standings cell is the same white outlined face — the legacy screen has no
// per-team colour (the colour is baked into the font's .bmp, not applied at runtime).
function Cell({text}: {text: string}) {
  return <BmpText font="beijing-16-out" text={text} />;
}
const HeaderCell = Cell;

function Table({rows, pointsMode}: {rows: WarTeamRow[]; pointsMode: boolean}) {
  return (
    <div class={`war-table ${pointsMode ? 'points' : ''}`}>
      <div class="war-row war-head">
        <HeaderCell text="Name" />
        <HeaderCell text={pointsMode ? 'Points' : 'Kills'} />
        {!pointsMode && <HeaderCell text="Deaths" />}
        <HeaderCell text="Life" />
        <HeaderCell text="Accuracy" />
        <HeaderCell text="Damage/hit" />
      </div>
      {rows.map((r, i) => (
        <div key={i} class="war-row">
          <Cell text={r.name} />
          <Cell text={String(r.kills)} />
          {!pointsMode && <Cell text={String(r.deaths)} />}
          <Cell text={pct(r.lifePct)} />
          <Cell text={pct(r.accuracyPct)} />
          <Cell text={String(Math.round(r.damagePerHit))} />
        </div>
      ))}
    </div>
  );
}

export function WarStandings() {
  const s = warStandings.value;
  if (!s) return null;
  return (
    <div class="war-standings" onClick={advanceWar}>
      {s.banner ? (
        <div class="war-banner">
          <BmpText font="bazouk-28" text={s.banner} />
        </div>
      ) : null}
      <div class="war-title">
        <BmpText font="bazouk-28" text={s.title} />
      </div>
      {s.subtitle.map((line, i) => (
        <div key={i} class="war-sub">
          <BmpText font="beijing-16-out" text={line} />
        </div>
      ))}

      <Table rows={s.rows} pointsMode={s.pointsMode} />

      {s.winCondition ? (
        <div class="war-wincond">
          <BmpText font="silkscreen-8-out" text={s.winCondition} />
        </div>
      ) : null}

      <div class="war-prompt">
        <BmpText font="beijing-16-out" text={s.prompt} />
      </div>
    </div>
  );
}
