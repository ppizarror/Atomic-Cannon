/**
 * One `< Label … Value >` config row, shared by the Settings pages and the Play
 * "Start Game" page. Toggles show `ON`/`OFF` (either half flips); enum / stepper rows
 * frame the value with `<` / `>` cycle arrows; nav rows are a whole-row button with a
 * trailing `>`. Hovering a row reports its tooltip to `onHover`.
 */
import {BmpText} from './BmpText';
import {type Widget} from './settingsPages';
import {clamp, wrapIndex} from '../math/num';

const ROW_FONT = 'bazouk-28';

export function WidgetRow({
  w,
  bump,
  onHover,
}: {
  w: Widget;
  bump: () => void;
  onHover: (s: string | null) => void;
}) {
  const enter = () => onHover(w.tip);
  const leave = () => onHover(null);

  // A nav row (opens a sub-page / editor): whole-row button, trailing `>`.
  if (w.kind === 'nav') {
    return (
      <button
        class="settings-row srow-nav menu-btn"
        onMouseEnter={enter}
        onFocus={enter}
        onMouseLeave={leave}
        onBlur={leave}
        onClick={() => w.onClick?.()}
      >
        <span class="srow-side">
          <BmpText font={ROW_FONT} text={w.label} />
        </span>
        <span class="srow-side srow-arrow">
          <BmpText font={ROW_FONT} text=">" />
        </span>
      </button>
    );
  }

  const val = w.get();
  const change = (dir: number) => {
    if (!w.set) return;
    if (w.kind === 'toggle') w.set(val ? 0 : 1);
    else if (w.kind === 'enum') w.set(wrapIndex(val + dir, w.options!.length));
    else {
      const step = w.step ?? 1,
        min = w.min ?? 0,
        max = w.max ?? 100;
      w.set(clamp(val + dir * step, min, max));
    }
    bump();
  };

  // A toggle row: label left, ON/OFF right, no arrows — either side flips it.
  if (w.kind === 'toggle') {
    return (
      <div class="settings-row menu-btn" onMouseEnter={enter} onMouseLeave={leave}>
        <button class="srow-half srow-left" onClick={() => change(1)}>
          <BmpText font={ROW_FONT} text={w.label} />
        </button>
        <button class="srow-half srow-right" onClick={() => change(1)}>
          <BmpText font={ROW_FONT} text={val ? 'ON' : 'OFF'} />
        </button>
      </div>
    );
  }

  // Enum / stepper: `< Label` (prev) on the left, `Value >` (next) on the right.
  const valueText =
    w.kind === 'enum' ? (w.options![val] ?? String(val)) : w.fmt ? w.fmt(val) : String(val);
  return (
    <div class="settings-row menu-btn" onMouseEnter={enter} onMouseLeave={leave}>
      <button class="srow-half srow-left" onClick={() => change(-1)}>
        <span class="srow-arrow">
          <BmpText font={ROW_FONT} text="<" />
        </span>
        <BmpText font={ROW_FONT} text={w.label} />
      </button>
      <button class="srow-half srow-right" onClick={() => change(1)}>
        <BmpText font={ROW_FONT} text={valueText} />
        <span class="srow-arrow">
          <BmpText font={ROW_FONT} text=">" />
        </span>
      </button>
    </div>
  );
}
