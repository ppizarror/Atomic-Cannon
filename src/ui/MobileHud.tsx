/**
 * Mobile / narrow-viewport HUD. Below MOBILE_W the raster gui.bmp control panel is
 * wider than the screen and gets cropped, so we swap it for a compact bottom strip
 * of tap targets — weapon, power, angle, buy, FIRE, menu — matching the classic
 * Atomic Cannon phone layout.
 *
 * The strip only shows readouts + opens things; the actual value editing happens in
 * a bottom sheet (a touch-sized slider) that slides up over the bar. Drag-to-aim on
 * the battlefield (see main.tsx pointer handlers) still works alongside this, so the
 * sheets are for precision and the readouts, not the only way to aim.
 */
import type {JSX} from 'preact';
import {signal} from '@preact/signals';
import {BmpText} from './BmpText';
import {WeaponIcon} from './WeaponIcon';
import {ClassicScrollbar} from './ClassicScrollbar';
import {useTrackDrag} from './useTrackDrag';
import {weaponName} from '../core/CWeapon';
import {clamp} from '../math/num';
import {strings} from '../i18n';
import {
  power,
  angle,
  wind,
  weaponIndex,
  weapons,
  blocked,
  paused,
  canBuyNow,
  battleStatus,
  turnTimer,
  timerFillStyle,
  game,
  uiClick,
  openDepot,
  openPauseMenu,
  POWER_MIN,
  POWER_MAX,
  wrapAngle,
} from './store';

// ==========================================================================
// SHEET STATE
// ==========================================================================

// Which bottom sheet (if any) is open. Module-level so the bar and the sheet share
// it without prop threading; reset whenever the bar re-decides it's blocked.
const sheet = signal<'weapon' | 'power' | 'angle' | null>(null);
const closeSheet = () => {
  sheet.value = null;
};

/** The currently-selected weapon def (falls back to the first). */
function currentWeapon() {
  return weapons.value.find(x => x.index === weaponIndex.value) ?? weapons.value[0];
}

// ---- THE BOTTOM STRIP ----------------------------------------------------
// A beveled metal button carrying one line of the game's `arial-14-out` bitmap
// font — the same chrome as the original phone HUD (thin strip of grey buttons on
// a dark bar), not stacked label/value pills.
function Btn({
  cls,
  text,
  onClick,
  disabled,
  title,
  children,
}: {
  cls?: string;
  text?: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children?: JSX.Element;
}) {
  return (
    <button
      class={`mbtn${cls ? ' ' + cls : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
      {text !== undefined && <BmpText class="mbtn-txt" font="arial-14-out" text={text} />}
    </button>
  );
}

// Thin shot-clock bar. Reuses the same turnTimer state as the desktop HUD: it
// drains green→yellow→red on a running Round Timer, flashes on a charging shot,
// and shows an inert dark track otherwise.
function MobileTimer() {
  const t = turnTimer.value;
  return <div class="mtimer">{t && <div class="mtimer-fill" style={timerFillStyle(t)} />}</div>;
}

// The right-end cluster: a top row of per-player lights (green for whose turn it
// is, red for the rest, dimmed when knocked out) over a wider shot-clock bar —
// the little indicator stack of the original bar.
function StatusCluster() {
  return (
    <div class="mstatus">
      <div class="mdots">
        {battleStatus.value.lines.map((l, i) => (
          <span key={i} class={`mdot${l.dead ? ' dead' : ''}${l.active ? ' on' : ''}`} />
        ))}
      </div>
      <MobileTimer />
    </div>
  );
}

function MobileBar() {
  const h = strings.value.hud;
  const off = blocked.value;
  const wp = currentWeapon();
  const toggle = (s: 'weapon' | 'power' | 'angle') => {
    if (off) return;
    uiClick();
    sheet.value = sheet.value === s ? null : s;
  };
  const open = (s: string) => (sheet.value === s ? ' open' : '');
  return (
    <div id="mhud">
      <div class="mbar">
        <Btn
          cls={`mweapon${off ? ' blocked' : ''}${open('weapon')}`}
          onClick={() => toggle('weapon')}
          disabled={off}
        >
          <>
            {wp && <WeaponIcon name={wp.icon} size={12} cls="micon" />}
            <BmpText class="mbtn-txt" font="arial-14-out" text={wp ? weaponName(wp) : ''} />
          </>
        </Btn>

        <Btn
          cls={`mval${off ? ' blocked' : ''}${open('power')}`}
          text={`${h.power} ${power.value}`}
          onClick={() => toggle('power')}
          disabled={off}
        />
        <Btn
          cls={`mval${off ? ' blocked' : ''}${open('angle')}`}
          text={`${h.angle} ${angle.value}`}
          onClick={() => toggle('angle')}
          disabled={off}
        />

        <Btn
          cls={`mbuy${off || !canBuyNow.value ? ' blocked' : ''}`}
          text="$"
          title={h.depot}
          onClick={() => {
            closeSheet();
            openDepot();
          }}
          disabled={off || !canBuyNow.value}
        />

        <Btn
          cls={`mfire${off ? ' blocked' : ''}`}
          text={h.fire}
          onClick={() => {
            closeSheet();
            if (game().isPlayerTurn()) game().requestFire();
          }}
          disabled={off}
        />

        <StatusCluster />

        {/* The menu (X) stays available during a bot's turn (unlike the greyed controls),
            so you can always pause — EXCEPT under the Ctrl/Cmd+P frame-test freeze, which
            blocks everything (paused → canAct() false, and this greys X to match). */}
        <Btn
          cls={`mmenu${paused.value ? ' blocked' : ''}`}
          text="X"
          title={h.menu}
          disabled={paused.value}
          onClick={() => {
            closeSheet();
            openPauseMenu();
          }}
        />
      </div>
    </div>
  );
}

// ---- SHEETS --------------------------------------------------------------
// Touch-sized editors; they slide up over the bar.

// A full-width horizontal slider. Press/drag anywhere on the track maps the
// pointer's X to a value; pointer capture keeps it tracking off the edges. Fine
// −/+ buttons flank it for single steps. Shared by power and angle.
function Slider({
  value,
  min,
  max,
  step,
  onValue,
  fmtValue,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onValue: (v: number) => void;
  fmtValue: (v: number) => string;
}) {
  const drag = useTrackDrag<HTMLDivElement>('x', f => onValue(min + f * (max - min)));
  const frac = clamp((value - min) / (max - min), 0, 1);
  return (
    <div class="msheet-row">
      <button class="mstep" onClick={() => onValue(value - step)}>
        −
      </button>
      <div class="mslider" {...drag}>
        <div class="mslider-fill" style={{width: `${frac * 100}%`}} />
        <div class="mslider-knob" style={{left: `${frac * 100}%`}} />
      </div>
      <button class="mstep" onClick={() => onValue(value + step)}>
        +
      </button>
      <span class="msheet-val">
        <BmpText font="beijing-16-out" text={fmtValue(value)} spacing={-1} />
      </span>
    </div>
  );
}

function PowerSheet() {
  return (
    <Slider
      value={power.value}
      min={POWER_MIN}
      max={POWER_MAX}
      step={10}
      onValue={v => game().setPower(clamp(Math.round(v), POWER_MIN, POWER_MAX))}
      fmtValue={v => String(Math.round(v))}
    />
  );
}

function AngleSheet() {
  return (
    <Slider
      value={angle.value}
      min={0}
      max={359}
      step={1}
      onValue={v => game().setAngle(wrapAngle(Math.round(v)))}
      fmtValue={v => `${Math.round(v)}°`}
    />
  );
}

function WeaponSheet() {
  const idx = weaponIndex.value;
  return (
    <ClassicScrollbar class="mwlist">
      {weapons.value.map((wp, i) => (
        <button
          key={wp.id}
          class={`mwrow${wp.index === idx ? ' active' : ''}`}
          onClick={() => {
            uiClick();
            game().selectWeapon(wp.index);
            closeSheet();
          }}
        >
          <WeaponIcon name={wp.icon} size={12} cls="micon" />
          <BmpText font="beijing-16-out" text={`${i + 1}. ${weaponName(wp)}`} spacing={-1} />
        </button>
      ))}
    </ClassicScrollbar>
  );
}

function Sheet() {
  const s = sheet.value;
  if (!s) return null;
  // Aim/power sheets vanish the moment it stops being your turn (forfeit / shot in
  // flight); the weapon list can stay but we close it too for a consistent feel.
  if (blocked.value) {
    closeSheet();
    return null;
  }
  return (
    <>
      <div class="msheet-scrim" onClick={closeSheet} />
      <div class={`msheet msheet-${s}`}>
        {s === 'power' && <PowerSheet />}
        {s === 'angle' && <AngleSheet />}
        {s === 'weapon' && <WeaponSheet />}
      </div>
    </>
  );
}

// Top-right wind readout — the mobile HUD has no room for the desktop wind dial, so this
// shows the same `wind` signal as a plain crisp text line (native size, no scaling), in the
// same style/corner as the FPS / frame counters: "Wind >N.N" (direction as ›/‹, magnitude).
function MobileWind() {
  const h = strings.value.hud;
  const w = wind.value;
  const mag = Math.abs(w);
  const txt = mag < 0.05 ? h.windOff : `${w >= 0 ? '>' : '<'}${mag.toFixed(1)}`;
  return (
    <div class="mwind">
      <BmpText font="beijing-16-out" spacing={-1} text={`${h.wind} ${txt}`} />
    </div>
  );
}

export function MobileHud() {
  return (
    <>
      <MobileWind />
      <Sheet />
      <MobileBar />
    </>
  );
}
