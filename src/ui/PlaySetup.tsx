/**
 * Play setup — the game-setup screen reached from the main menu's "Play". Offers the
 * faithful presets (Quick Start / 2 Player / Watch), each starting a battle at once,
 * plus a custom player count: total tanks and how many are human (the rest CPU). Start
 * Game begins with the chosen counts; the setup persists so Quick Play can replay it.
 * Per-player name / colour / tank come from Customize Players.
 */
import {useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {Button} from './Button';
import {MenuButton} from './MenuButton';
import {backToMenu, startBattle, uiClick} from './store';
import {setup, MIN_TANKS, MAX_TANKS} from './setupStore';

const clampHumans = (humans: number, total: number): number => Math.min(total, Math.max(0, humans));

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const step = (d: number) => {
    const v = Math.min(max, Math.max(min, value + d));
    if (v !== value) {
      uiClick();
      onChange(v);
    }
  };
  return (
    <div class="setup-row">
      <span class="setup-label">
        <BmpText font="msans-14" text={label} tint="#eef2f6" />
      </span>
      <Button label="<" onClick={() => step(-1)} class="setup-step" />
      <span class="setup-value">
        <BmpText font="trebuchet-18" text={String(value)} tint="#eef2f6" />
      </span>
      <Button label=">" onClick={() => step(1)} class="setup-step" />
    </div>
  );
}

export function PlaySetup() {
  const [total, setTotal] = useState(setup.value.total);
  const [humans, setHumans] = useState(setup.value.humans);

  const setTotalClamped = (t: number) => {
    setTotal(t);
    setHumans(h => clampHumans(h, t)); // never more humans than tanks
  };

  return (
    <div class="settings-screen">
      <div class="setup-panel">
        <div class="setup-title">
          <BmpText font="bazouk-28" text="Play" />
        </div>

        <div class="menu-list setup-presets">
          <MenuButton label="Quick Start" font="beijing-20-out" onClick={() => startBattle(2, 1)} />
          <MenuButton label="2 Player" font="beijing-20-out" onClick={() => startBattle(2, 2)} />
          <MenuButton label="Watch" font="beijing-20-out" onClick={() => startBattle(2, 0)} />
        </div>

        <div class="setup-custom">
          <Stepper
            label="Players"
            value={total}
            min={MIN_TANKS}
            max={MAX_TANKS}
            onChange={setTotalClamped}
          />
          <Stepper label="Humans" value={humans} min={0} max={total} onChange={setHumans} />
          <div class="setup-hint">
            <BmpText
              font="msans-14"
              text={`${humans} human vs ${total - humans} CPU`}
              tint="#c9d2da"
            />
          </div>
        </div>

        <div class="setup-buttons">
          <Button label="Start Game" onClick={() => startBattle(total, humans)} />
          <Button label="Back" onClick={backToMenu} class="setup-back" />
        </div>
      </div>
    </div>
  );
}
