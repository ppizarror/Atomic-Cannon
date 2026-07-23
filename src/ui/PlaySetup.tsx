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
import {BmpText} from './BmpText';
import {WidgetRow} from './WidgetRow';
import {backToMenu, startBattle, MIN_PLAYERS} from './store';
import {type Widget, stepper, enumW} from './settingsPages';
import {
  setup,
  setSetup,
  MAX_HUMANS,
  MAX_COMPUTERS,
  MIN_TANKS_PER_TEAM,
  MAX_TANKS_PER_TEAM,
} from './setupStore';

// A stepper bound to one field of the per-match setup (Humans / Computers / Tanks).
const countRow = (
  label: string,
  tip: string,
  key: 'humans' | 'computers' | 'tanksPerTeam',
  min: number,
  max: number,
): Widget => ({
  label,
  tip,
  kind: 'stepper',
  min,
  max,
  step: 1,
  get: () => setup.value[key],
  set: v => setSetup({...setup.value, [key]: v}),
});

const NEED_PLAYERS = `Add at least ${MIN_PLAYERS} players (humans + computers) to start`;

export function PlaySetup() {
  const [, setTick] = useState(0);
  const bump = () => setTick(v => v + 1);
  const [sub, setSub] = useState<string | null>(null);

  const s = setup.value; // subscribe so the Start Game guard updates as counts change
  const canStart = s.humans + s.computers >= MIN_PLAYERS;

  const rows: Widget[] = [
    countRow('Humans', 'Number of human players', 'humans', 0, MAX_HUMANS),
    countRow('Computers', 'Number of computer AI players', 'computers', 0, MAX_COMPUTERS),
    countRow(
      'Tanks',
      "Number of tanks per player's team",
      'tanksPerTeam',
      MIN_TANKS_PER_TEAM,
      MAX_TANKS_PER_TEAM,
    ),
    enumW('Game Type', 'What type of battle', 'gp.gameType'),
    stepper('Battles', 'How many battles per Deathmatch', 'gp.battles', 1, 50, 1),
    stepper('Rounds', 'How many rounds in a Point game', 'gp.rounds', 1, 50, 1),
    enumW('Land Size', 'How large the battle landscape is', 'gp.landSize'),
    enumW('Difficulty', 'How badly the computer will dominate you', 'gp.difficulty'),
    enumW('Wind', 'How the wind affects the trajectories', 'gp.wind'),
  ];

  return (
    <div class="settings-screen">
      <div class="menu-list settings-rows">
        <button
          class="settings-row srow-done menu-btn"
          disabled={!canStart}
          onMouseEnter={() => setSub('Start the game')}
          onMouseLeave={() => setSub(null)}
          onClick={startBattle}
        >
          <BmpText font="bazouk-28" text="Start Game" />
        </button>

        {rows.map((w, i) => (
          <WidgetRow key={i} w={w} bump={bump} onHover={setSub} />
        ))}

        <button
          class="settings-row srow-done menu-btn"
          onMouseEnter={() => setSub('Return to the main menu')}
          onMouseLeave={() => setSub(null)}
          onClick={backToMenu}
        >
          <BmpText font="bazouk-28" text="Cancel" />
        </button>
      </div>
      <div class="settings-subtitle">
        <BmpText
          font="beijing-16-out"
          text={sub ?? (canStart ? 'Play' : NEED_PLAYERS)}
          spacing={-1}
        />
      </div>
    </div>
  );
}
