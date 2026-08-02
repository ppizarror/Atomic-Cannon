/**
 * In-battle HUD. The control panel is the `gui.bmp` sprite; live content
 * (weapon list, power fill, FIRE, angle needle, wind) and click hotspots are
 * positioned over it as a percentage of the 640x120 panel.
 *
 * Each frequently-changing readout is its own leaf component that reads a single
 * signal, so the 104-row weapon list only re-renders when the weapon changes
 * (not every frame) — keeps it cheap and lets async icons stick.
 */
import {useEffect, useRef} from 'preact/hooks';
import type {JSX, ComponentChildren, TargetedWheelEvent} from 'preact';
import {BmpText} from './BmpText';
import {
  power,
  angle,
  wind,
  weaponIndex,
  playerName,
  life,
  maxLife,
  shield,
  blocked,
  weapons,
  game,
  uiClick,
  battleStatus,
  statusWindow,
  statusLeftFrac,
  openDepot,
  canBuyNow,
  openPauseMenu,
  openHelp,
  POWER_MIN,
  POWER_MAX,
  wrapAngle,
  turnTimer,
  timerFillStyle,
  teamId,
  armor,
  hazmat,
  posX,
  posY,
  credits,
  windVelX,
  windVelY,
  windAccX,
  windAccY,
  canMoveNow,
  loadUiBmp,
  isMobile,
} from './store';
import {MobileHud} from './MobileHud';
import {weaponPower, weaponDamagePerArea, weaponName, weaponTypeName} from '../core/CWeapon';
import {strings} from '../i18n';
import {clamp, wrapIndex} from '../math/num';
import {WeaponIcon} from './WeaponIcon';
import {usePointerDrag} from './usePointerDrag';
import {useTrackDrag} from './useTrackDrag';
import {useAsyncImage} from './useAsyncImage';

// Element rectangles within the gui.bmp panel: [left%, top%, width%, height%].
// Measured off a gridded render of the 640x120 panel.
const R = {
  // Extents measured directly from the gui.bmp pixels (button faces + black boxes).
  list: [1, 11.7, 29.1, 70.8],
  up: [30.8, 12, 3.5, 18],
  down: [30.8, 63, 3.5, 18],
  plus: [38.3, 16, 4.6, 19],
  minus: [38.3, 62, 4.6, 18.5],
  pnum: [38.3, 40, 5.0, 19.2], // black readout box between +/−
  wicon: [30.8, 34.2, 5.0, 26.7], // 32x32 preview of the selected weapon
  meter: [45.35, 16.3, 4.25, 64.5], // the coloured gradient column only

  fire: [54.8, 16.5, 15, 29.5],
  timer: [56.3, 50.3, 14.2, 3], // shot-time bar (thin), just below FIRE
  buy: [55, 64.6, 3.2, 18],
  reset: [60.8, 64, 3.2, 18],
  help: [66.8, 64, 3.2, 18],
  aleft: [75.5, 64, 2.7, 17],
  aright: [84.0, 64, 2.7, 17],
  anglen: [76.1, 67, 10, 11], // number box, lower-centre of the dial
  close: [94.6, 14, 3.4, 18],
  wind: [90.6, 42.5, 7.5, 40],

  // group captions printed on the metal below each cluster (black text)
  lblWeapon: [1.5, 82, 28.5, 16],
  lblPower: [33, 82, 17, 16],
  lblAngle: [73, 82, 17, 16],
  lblWind: [87.5, 82, 11, 16],
} as const;

// Square (px) box centred on the dial circle so the needle stays circular and
// pivots at the ring's centre (11.5% × 736px ≈ 61.3% × 138px ≈ 85px square).
const DIAL_BOX = [75.35, 8.6, 11.5, 61.3] as const;
// Grab layer over the dial face for drag-to-aim. Same left/width as the dial but
// stops short of the ◀/▶ buttons (top ~64%) so it never steals their clicks.
const DIAL_GRAB = [75.35, 8.6, 11.5, 52] as const;
const ANGLE_PER_PX = 0.5; // degrees of aim per pixel of horizontal drag

const pos = (r: readonly number[]): JSX.CSSProperties => ({
  position: 'absolute',
  left: `${r[0]}%`,
  top: `${r[1]}%`,
  width: `${r[2]}%`,
  height: `${r[3]}%`,
});

function Hotspot({
  r,
  onClick,
  title,
  disabled,
}: {
  r: readonly number[];
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  // Held (paused / not your turn) or explicitly disabled (e.g. depot closed by Buy Time):
  // grey the button face and drop its pointer events.
  const off = blocked.value || !!disabled;
  return (
    <button
      class={`ov-hotspot${off ? ' blocked' : ''}`}
      style={pos(r)}
      title={title}
      onClick={onClick}
      disabled={off}
    />
  );
}

// ---- leaf readouts (each subscribes to exactly one live signal) -------------
function ReadoutBox({r, children}: {r: readonly number[]; children: ComponentChildren}) {
  return (
    <div class="ov readout-box" style={pos(r)}>
      {children}
    </div>
  );
}

// Static black caption printed on the metal under a control cluster.
function PanelLabel({r, text, left}: {r: readonly number[]; text: string; left?: boolean}) {
  return (
    <div class="ov readout-box" style={{...pos(r), justifyContent: left ? 'flex-start' : 'center'}}>
      <BmpText font="msans-14" text={text} />
    </div>
  );
}

// The power column. Besides showing the fill it is grabbable: press anywhere on
// it and drag to set power, mapping the pointer's Y to a value (top = POWER_MAX,
// bottom = POWER_MIN). Pointer capture keeps the drag tracking even when the
// cursor slips off the narrow bar sideways.
function MeterOverlay() {
  const p = power.value;
  const emptyH = R.meter[3] * (1 - (p - POWER_MIN) / (POWER_MAX - POWER_MIN));
  // Top of the meter is MAX power, so the fraction runs backwards down the track.
  const drag = useTrackDrag<HTMLDivElement>('y', frac =>
    game().setPower(Math.round(POWER_MAX - frac * (POWER_MAX - POWER_MIN))),
  );

  return (
    <>
      <div
        class="ov meter-empty"
        style={{
          position: 'absolute',
          left: `${R.meter[0]}%`,
          top: `${R.meter[1]}%`,
          width: `${R.meter[2]}%`,
          height: `${emptyH}%`,
        }}
      />
      <ReadoutBox r={R.pnum}>
        <BmpText font="beijing-16-out" text={String(p)} />
      </ReadoutBox>
      <div
        class={`ov meter-drag${blocked.value ? ' blocked' : ''}`}
        style={pos(R.meter)}
        title={strings.value.hud.powerTitle}
        {...drag}
      />
    </>
  );
}

function FireButton() {
  const off = blocked.value; // held when paused or when it's not the human's turn
  return (
    <button
      class={`ov fire-btn${off ? ' disabled' : ''}`}
      style={pos(R.fire)}
      disabled={off}
      onClick={() => {
        if (game().isPlayerTurn()) game().requestFire();
      }}
    >
      <BmpText font="fire" text={strings.value.hud.fire} height={38} />
    </button>
  );
}

// The bar below FIRE. Three looks driven by getTurnTimer():
//  • charge — a shot winding up: fill grows red 0→full, then flashes green as it launches.
//  • timer  — Round Timer on: fill drains right→left, shading green→yellow→red.
//  • off    — Round Timer disabled (this player's turn): an inert dark track, no red cap.
// Hidden (null) whenever there's nothing to show (bot turn, shot in flight).
function TurnTimerBar() {
  const t = turnTimer.value;
  if (!t) return null;
  return (
    <div class="ov turn-timer" style={pos(R.timer)}>
      <div class="tt-track">
        <div class="tt-fill" style={timerFillStyle(t)} />
      </div>
    </div>
  );
}

// The angle-dial pointer sprite (guiAnglePointerBig.bmp): a red needle on black with
// magenta mount pixels, both keyed out. It points UP in the bitmap (tip at top, base at
// the bottom), so we pivot at its base — the dial centre (50,50) — and rotate it to the
// aim. Local length/width in the 100×100 viewBox; width tracks the 5:28 source ratio so
// it never distorts. The old stroked line stays as the fallback until the sprite loads.
const NDL_LEN = 32; // pointer length, ~matches the old needle reach
const NDL_W = (5 / 28) * NDL_LEN; // preserve the sprite's 5×28 aspect

function Needle() {
  const a = angle.value;
  // Sprite drawn pointing UP represents aim = 90 (screen-up); rotate by (90 − a) so
  // a=0→right, a=90→up, a=270→down — matching the ◀/▶ aim and the old line.
  const rot = `rotate(${90 - a} 50 50)`;
  const src = useAsyncImage(() => loadUiBmp('gui/guiAnglePointerBig.bmp', 'blackmagenta'), []);
  return (
    <svg
      class="ov dial-overlay"
      style={pos(DIAL_BOX)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {src ? (
        <image
          class="needle-sprite"
          href={src}
          x={50 - NDL_W / 2}
          y={50 - NDL_LEN}
          width={NDL_W}
          height={NDL_LEN}
          transform={rot}
          preserveAspectRatio="none"
        />
      ) : (
        <line class="needle" x1="50" y1="50" x2="50" y2="18" transform={rot} />
      )}
    </svg>
  );
}

function AngleReadout() {
  return (
    <ReadoutBox r={R.anglen}>
      <BmpText font="beijing-16-out" text={`${angle.value}`} />
    </ReadoutBox>
  );
}

// Horizontal drag over the dial scrubs the aim: drag left → aim left (angle up),
// drag right → aim right (angle down), matching the ◀/▶ buttons. Relative to the
// press point so the needle doesn't jump; pointer capture keeps it tracking when
// the cursor slips off the small dial.
function DialGrab() {
  const drag = useRef<{x: number; a: number; seq: number} | null>(null);
  const handlers = usePointerDrag<HTMLDivElement>({
    onStart: e => {
      drag.current = {x: e.clientX, a: game().getAngle(), seq: game().turnSeq()};
    },
    onMove: e => {
      const d = drag.current;
      // Stop applying if the turn changed mid-drag (forfeit hand-off past a captured pointer).
      if (d && game().turnSeq() === d.seq)
        game().setAngle(wrapAngle(Math.round(d.a - (e.clientX - d.x) * ANGLE_PER_PX)));
    },
  });
  return (
    <div
      class={`ov dial-drag${blocked.value ? ' blocked' : ''}`}
      style={pos(DIAL_GRAB)}
      title={strings.value.hud.aimTitle}
      {...handlers}
    />
  );
}

function WindReadout() {
  const w = wind.value;
  const txt =
    Math.abs(w) < 0.05
      ? strings.value.hud.windOff
      : `${w >= 0 ? '>' : '<'}${Math.abs(w).toFixed(1)}`;
  return (
    <ReadoutBox r={R.wind}>
      <BmpText font="silkscreen-8-white" text={txt} />
    </ReadoutBox>
  );
}

// The 32x32 preview of the current weapon, in the box between the ▲/▼ arrows.
// The weapon rows/preview key off each weapon's real database `index`, not its
// position in the (possibly filtered) displayed list, so selection and highlight
// stay correct regardless of how the list is scoped.
function WeaponPreview() {
  const wp = currentWeapon();
  return (
    <div class="ov weapon-preview" style={pos(R.wicon)}>
      {wp && <WeaponIcon name={wp.icon} size={32} cls="wbig" />}
    </div>
  );
}

// Step the weapon selection by ±1 with wrap-around — shared by the ▲/▼ buttons, the
// list's mouse-wheel, and the Previous/Next-weapon keys. +1 = next (▼), −1 = previous
// (▲); wraps past either end.
export function stepWeapon(d: number): void {
  const list = weapons.value;
  if (!list.length) return;
  uiClick();
  const g = game();
  const cur = Math.max(
    0,
    list.findIndex(w => w.index === g.getCurrentWeaponIndex()),
  );
  const next = wrapIndex(cur + d, list.length);
  g.selectWeapon(list[next].index);
}

function WeaponList() {
  const listRef = useRef<HTMLDivElement>(null);
  const wheelAcc = useRef(0);
  const lastStep = useRef(0);
  const idx = weaponIndex.value;
  useEffect(() => {
    (listRef.current?.querySelector('.wrow.active') as HTMLElement | null)?.scrollIntoView({
      block: 'nearest',
    });
  }, [idx]);
  // Mouse-wheel over the list steps the selection like the ▲/▼ arrows (no visible
  // scrollbar). Delta is accumulated (normalised from line/page modes to px) so
  // sub-notch scrolls add up; a step consumes exactly STEP px (the leftover carries
  // for a snappy, continuous feel), and MIN_MS caps the top speed so a hard flick
  // can't blow through the list. The backlog is clamped to MAX_ACC so scrolling
  // stops promptly (no drift) and the next nudge isn't twitchy.
  const onWheel = (e: TargetedWheelEvent<HTMLDivElement>) => {
    if (blocked.value || !e.deltaY) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? e.currentTarget.clientHeight : 1;
    const STEP = 38; // px of scroll per weapon step
    const MIN_MS = 30; // min gap between steps → ~33 weapons/sec ceiling
    const MAX_ACC = 2 * STEP; // cap the backlog so it can't run on after you stop
    wheelAcc.current = clamp(wheelAcc.current + e.deltaY * unit, -MAX_ACC, MAX_ACC);
    const now = performance.now();
    if (Math.abs(wheelAcc.current) >= STEP && now - lastStep.current >= MIN_MS) {
      stepWeapon(wheelAcc.current > 0 ? 1 : -1);
      wheelAcc.current -= Math.sign(wheelAcc.current) * STEP; // keep the remainder
      lastStep.current = now;
    }
  };
  return (
    <div
      class={`ov wlist${blocked.value ? ' blocked' : ''}`}
      style={pos(R.list)}
      ref={listRef}
      onWheel={onWheel}
    >
      {weapons.value.map((wp, i) => {
        const active = wp.index === idx;
        return (
          <div
            key={wp.id}
            class={`wrow${active ? ' active' : ''}`}
            onClick={() => {
              uiClick();
              game().selectWeapon(wp.index);
            }}
          >
            <WeaponIcon name={wp.icon} size={16} cls="wicon" />
            <BmpText
              class="wtext"
              font="beijing-16-out"
              // Number by POSITION in the arsenal (buy order): "1." = first weapon bought, etc.
              text={`${i + 1}. ${weaponName(wp)}`}
              spacing={-1}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---- static structure (renders once) ---------------------------------------
function ControlPanel() {
  const g = () => game();
  const dP = (d: number) => g().setPower(clamp(g().getPower() + d, POWER_MIN, POWER_MAX));
  const dA = (d: number) => g().setAngle(wrapAngle(g().getAngle() + d));
  // ▲/▼ step through the displayed list with wrap-around (see stepWeapon), the
  // same path the list's mouse-wheel uses.
  const dW = stepWeapon;
  const h = strings.value.hud;

  return (
    <div id="hud-panel">
      <img class="panel-bg" src="/assets/gui/gui.bmp" alt="" />
      <WeaponList />
      <WeaponPreview />
      <Hotspot r={R.up} title={h.prevWeapon} onClick={() => dW(-1)} />
      <Hotspot r={R.down} title={h.nextWeapon} onClick={() => dW(1)} />
      <Hotspot r={R.plus} title={h.powerUp} onClick={() => dP(50)} />
      <Hotspot r={R.minus} title={h.powerDown} onClick={() => dP(-50)} />
      <MeterOverlay />
      <FireButton />
      <TurnTimerBar />
      <Hotspot r={R.buy} title={h.depot} onClick={openDepot} disabled={!canBuyNow.value} />
      <Hotspot
        r={R.reset}
        title={h.resetShot}
        onClick={() => {
          uiClick();
          game().resetAim();
        }}
      />
      <Hotspot r={R.help} title={h.help} onClick={openHelp} />
      <Needle />
      <AngleReadout />
      <DialGrab />
      <Hotspot r={R.aleft} title={h.aimLeft} onClick={() => dA(2)} />
      <Hotspot r={R.aright} title={h.aimRight} onClick={() => dA(-2)} />
      <WindReadout />
      <Hotspot r={R.close} title={h.menu} onClick={openPauseMenu} />
      <PanelLabel r={R.lblWeapon} text={h.selectWeapon} left />
      <PanelLabel r={R.lblPower} text={h.power} />
      <PanelLabel r={R.lblAngle} text={h.angle} />
      <PanelLabel r={R.lblWind} text={h.wind} />
    </div>
  );
}

// Top-left status overlay: each player's "NAME: N% life" then "Battle X of Y - Shot Z" (white).
// Past `rows` players (`compact`) the list is cut down — a full roster would otherwise run down
// the screen. See statusWindow for what replaces it.
function BattleStatus() {
  const s = battleStatus.value;
  const lines = statusWindow(s.lines, s);
  // On large maps the overview minimap occupies the top-left corner, so the status
  // lines shift right to sit beside it (matching the original).
  const lf = statusLeftFrac.value;
  return (
    <div id="battle-status" style={lf ? {left: `${lf * 100}%`} : undefined}>
      {lines.map((l, i) => (
        <div
          key={i}
          class={`bstat-line${l.active ? ' active' : ''}${l.dead ? ' dead' : ''}`}
          style={l.active ? {background: l.color + '80', borderColor: l.color} : undefined}
        >
          <BmpText font="beijing-16-out" text={l.text} height={18} spacing={-1} />
        </div>
      ))}
      <div class="bstat-line">
        <BmpText font="beijing-16-out" text={s.battle} height={18} spacing={-1} />
      </div>
      {s.notice && (
        <div class="bstat-line">
          <BmpText font="beijing-16-out" text={s.notice} height={18} spacing={-1} />
        </div>
      )}
    </div>
  );
}

// A single bitmap-font line inside a black side box.
function LcdLine({text}: {text: string}) {
  return <BmpText class="lcd-line" font="silkscreen-8-white" text={text} spacing={2} />;
}

/** The currently-selected weapon def (falls back to the first). */
function currentWeapon() {
  return weapons.value.find(x => x.index === weaponIndex.value) ?? weapons.value[0];
}

// The side-LCD boxes flank the central control panel: two weapon boxes to the
// LEFT, two tank/world boxes to the RIGHT. Each is appended outward only when the
// screen is wide enough to hold it (the width-gating lives in hud.css, revealing
// outermost boxes last). A third left box — "Weapon Desc" — is omitted: most
// weapons carry no description.

// L1 — WEAPON DETAILS (innermost left). Power + Damage-per-area are DERIVED stats
// (see weaponPower/weaponDamagePerArea); Fodder is the raw fraction shown as a %.
function WeaponDetails1() {
  const w = currentWeapon();
  const h = strings.value.hud;
  return (
    <div class="side-lcd wpn" id="weapon-details">
      <LcdLine text={h.weaponDetails} />
      {w && (
        <>
          <LcdLine text={`${h.lcd.type} ${weaponTypeName(w.type)}`} />
          <LcdLine text={`${h.lcd.power} ${weaponPower(w)}`} />
          <LcdLine text={`${h.lcd.damage} ${w.damage}`} />
          <LcdLine text={`${h.lcd.radius} ${w.radius}`} />
          <LcdLine text={`${h.lcd.variance} ${(w.variance ?? 0).toFixed(1)}`} />
          <LcdLine text={`${h.lcd.fodder} ${Math.round((w.fodder ?? 0) * 100)}%`} />
          <LcdLine text={`${h.lcd.dmgPerArea} ${weaponDamagePerArea(w)}`} />
        </>
      )}
    </div>
  );
}

// L2 — WEAPON DETAILS (second left). Cluster = total submunitions cluNum^cluRecurse
// (raw cluNum when it doesn't recurse); Succession is stored+1; Radiation is the
// irDmg·fodder·radius·100 rating.
function WeaponDetails2() {
  const w = currentWeapon();
  const cluster = w
    ? (w.cluRecurse ?? 0) > 0
      ? Math.pow(Math.trunc(w.cluNum), Math.trunc(w.cluRecurse))
      : (w.cluNum ?? 0)
    : 0;
  const h = strings.value.hud;
  return (
    <div class="side-lcd wpn" id="weapon-details-2">
      <LcdLine text={h.weaponDetails} />
      {w && (
        <>
          <LcdLine text={`${h.lcd.earth} ${w.earth ?? 0}`} />
          <LcdLine text={`${h.lcd.spawn} ${w.spawn ?? 0}`} />
          <LcdLine text={`${h.lcd.cluster} ${cluster}`} />
          <LcdLine text={`${h.lcd.succession} ${(w.sucNum ?? 0) + 1}`} />
          <LcdLine text={`${h.lcd.battery} ${w.batSec ?? 0}`} />
          <LcdLine
            text={`${h.lcd.radiation} ${Math.round((w.irDmg ?? 0) * (w.fodder ?? 0) * w.radius * 100)}`}
          />
        </>
      )}
    </div>
  );
}

// R1 — tank stats (innermost right), titled with the acting tank's name.
function PlayerStats() {
  const s = strings.value.hud.stat;
  return (
    <div class="side-lcd" id="player-stats">
      <LcdLine text={playerName.value.toUpperCase()} />
      <LcdLine text={`${s.team} ${teamId.value}`} />
      <LcdLine text={`${s.life} ${life.value}/${maxLife.value}`} />
      <LcdLine text={`${s.shield} ${shield.value}/1000`} />
      <LcdLine text={`${s.armor} ${armor.value}%`} />
      <LcdLine text={`${s.hazmat} ${hazmat.value}%`} />
      <LcdLine text={`${s.credits} ${credits.value}`} />
      <LcdLine text={`${s.position} ${posX.value} ${posY.value}`} />
    </div>
  );
}

// R2 — WIND MEASUREMENTS (outermost right): wind velocity + acceleration and
// whether the acting tank is free to move (else it's stuck underground).
function WindMeasurements() {
  const f = (n: number) => n.toFixed(2);
  const h = strings.value.hud;
  return (
    <div class="side-lcd" id="wind-measurements">
      <LcdLine text={h.windMeasurements} />
      <LcdLine text={`${h.vel} ${f(windVelX.value)} ${f(windVelY.value)}`} />
      <LcdLine text={`${h.acc} ${f(windAccX.value)} ${f(windAccY.value)}`} />
      {canMoveNow.value ? (
        <LcdLine text={h.canMove} />
      ) : (
        <>
          <LcdLine text={h.cantMove} />
          <LcdLine text={h.underground} />
        </>
      )}
    </div>
  );
}

export function Hud() {
  return (
    <>
      <BattleStatus />
      {isMobile.value ? (
        <MobileHud />
      ) : (
        <div id="hud">
          <WeaponDetails2 />
          <WeaponDetails1 />
          <ControlPanel />
          <PlayerStats />
          <WindMeasurements />
        </div>
      )}
    </>
  );
}
