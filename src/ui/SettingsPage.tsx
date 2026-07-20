/**
 * A single option page in the Settings tree (Gameplay / Audio / …). Renders the
 * page's widget rows over the same darkened title backdrop as the root: two-column
 * rows with the label LEFT and the value RIGHT. Cyclable
 * rows (enum / stepper) frame the value with `‹ … ›` cycle arrows (rendered as
 * `<`/`>`, the glyphs the bitmap fonts carry); toggles show `ON`/`OFF` with no
 * arrows. A centered `Done` returns to the Settings root. Hovering a row shows its
 * description centered along the bottom edge; with nothing hovered the page's own
 * header line shows there instead.
 */
import { useState } from 'preact/hooks';
import { settingsPageBack } from './store';
import { BmpText } from './BmpText';
import { getSettingsPage, type Widget } from './settingsPages';

const ROW_FONT = 'bazouk-28';

const wrap = (i: number, n: number) => ((i % n) + n) % n;

function RowView({ w, bump, onHover }: {
  w: Widget;
  bump: () => void;
  onHover: (s: string | null) => void;
}) {
  const enter = () => onHover(w.tip);
  const leave = () => onHover(null);

  // A nav row (opens a sub-page / editor): whole-row button, trailing `>`.
  if (w.kind === 'nav') {
    return (
      <button class="settings-row srow-nav menu-btn"
        onMouseEnter={enter} onFocus={enter} onMouseLeave={leave} onBlur={leave}
        onClick={() => w.onClick?.()}>
        <span class="srow-side"><BmpText font={ROW_FONT} text={w.label} /></span>
        <span class="srow-side srow-arrow"><BmpText font={ROW_FONT} text=">" /></span>
      </button>
    );
  }

  const val = w.get();
  const change = (dir: number) => {
    if (!w.set) return;
    if (w.kind === 'toggle') w.set(val ? 0 : 1);
    else if (w.kind === 'enum') w.set(wrap(val + dir, w.options!.length));
    else {
      const step = w.step ?? 1, min = w.min ?? 0, max = w.max ?? 100;
      w.set(Math.max(min, Math.min(max, val + dir * step)));
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
  const valueText = w.kind === 'enum'
    ? (w.options![val] ?? String(val))
    : (w.fmt ? w.fmt(val) : String(val));
  return (
    <div class="settings-row" onMouseEnter={enter} onMouseLeave={leave}>
      <button class="srow-half srow-left" onClick={() => change(-1)}>
        <span class="srow-arrow"><BmpText font={ROW_FONT} text="<" /></span>
        <BmpText font={ROW_FONT} text={w.label} />
      </button>
      <button class="srow-half srow-right" onClick={() => change(1)}>
        <BmpText font={ROW_FONT} text={valueText} />
        <span class="srow-arrow"><BmpText font={ROW_FONT} text=">" /></span>
      </button>
    </div>
  );
}

export function SettingsPage({ id }: { id: string }) {
  const [, setTick] = useState(0);
  const bump = () => setTick((v) => v + 1);
  const [sub, setSub] = useState<string | null>(null);

  const page = getSettingsPage(id);
  if (!page) return null;

  return (
    <div class="settings-screen">
      <div class="settings-rows">
        {page.rows.map((w, i) => (
          <RowView key={i} w={w} bump={bump} onHover={setSub} />
        ))}
        <button class="settings-row srow-done menu-btn"
          onMouseEnter={() => setSub('Return to the settings menu')}
          onMouseLeave={() => setSub(null)}
          onClick={settingsPageBack}>
          <BmpText font="bazouk-28" text="Done" />
        </button>
      </div>
      <div class="settings-subtitle">
        <BmpText font="msans-14" text={sub ?? page.header} tint="#eef2f6" />
      </div>
    </div>
  );
}
