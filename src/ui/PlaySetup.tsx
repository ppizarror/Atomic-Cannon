/**
 * The Play menu — the "Start Game" configuration page reached from the main menu.
 * A widget list (same `< Label … Value >` rows as Settings) over the darkened title
 * backdrop: a top **Start Game** button, the match config rows, and **Cancel**.
 *
 * The counts (Humans / Computers / Tanks-per-team) bind to the per-match `setupStore`;
 * the shared options (Game Type / Battles / Rounds / Land Size / Difficulty / Wind)
 * bind to the same persisted settings the Settings tree edits. Start Game launches with
 * the current values; the setup persists so Quick Play replays it. Per-player name /
 * colour / tank come from Customize Players.
 */
import {useState} from 'preact/hooks';
import {strings, fmt} from '../i18n';
import type {RowCopy} from '../i18n';
import {BigButton} from './BigButton';
import {MenuScreen} from './MenuScreen';
import {WidgetRow} from './WidgetRow';
import {useForceRender} from './useForceRender';
import {useMenuNav} from './useMenuNav';
import {backToMenu, startBattle, MIN_PLAYERS} from './store';
import {type Widget, stepper, enumW} from './settingsPages';
import {setup, setSetup, MAX_HUMANS, MAX_COMPUTERS, MIN_TANKS_PER_TEAM, MAX_TANKS_PER_TEAM} from './setupStore';

// A stepper bound to one field of the per-match setup (Humans / Computers / Tanks).
const countRow = (c: RowCopy, key: 'humans' | 'computers' | 'tanksPerTeam', min: number, max: number): Widget => ({
  label: c.label,
  tip: c.tip,
  kind: 'stepper',
  min,
  max,
  step: 1,
  get: () => setup.value[key],
  set: v => setSetup({...setup.value, [key]: v}),
});

export function PlaySetup() {
  const bump = useForceRender();
  const [sub, setSub] = useState<string | null>(null);
  const navRef = useMenuNav('play');

  const p = strings.value.play;
  const s = setup.value; // subscribe so the Start Game guard updates as counts change
  const canStart = s.humans + s.computers >= MIN_PLAYERS;

  const rows: Widget[] = [
    countRow(p.humans, 'humans', 0, MAX_HUMANS),
    countRow(p.computers, 'computers', 0, MAX_COMPUTERS),
    countRow(p.tanks, 'tanksPerTeam', MIN_TANKS_PER_TEAM, MAX_TANKS_PER_TEAM),
    enumW(p.gameType, 'gp.gameType'),
    stepper(p.battles, 'gp.battles', 1, 50, 1),
    stepper(p.rounds, 'gp.rounds', 1, 50, 1),
    enumW(p.landSize, 'gp.landSize'),
    enumW(p.difficulty, 'gp.difficulty'),
    enumW(p.wind, 'gp.wind'),
  ];

  return (
    <MenuScreen subtitle={sub ?? (canStart ? p.ready : fmt(p.needPlayers, {min: MIN_PLAYERS}))} spacing={-1}>
      <div class="menu-list settings-rows" ref={navRef}>
        <BigButton
          label={p.startGame}
          disabled={!canStart}
          onEnter={() => setSub(p.startHint)}
          onLeave={() => setSub(null)}
          onClick={startBattle}
        />

        {rows.map((w, i) => (
          <WidgetRow key={i} w={w} bump={bump} onHover={setSub} />
        ))}

        <BigButton
          label={p.cancel}
          onEnter={() => setSub(p.cancelHint)}
          onLeave={() => setSub(null)}
          onClick={backToMenu}
        />
      </div>
    </MenuScreen>
  );
}
