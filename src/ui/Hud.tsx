/**
 * In-battle HUD. The control panel is the original `gui.bmp` sprite; live content
 * (weapon list, power fill, FIRE, angle needle, wind) and click hotspots are
 * positioned over it as a percentage of the 640x120 panel.
 *
 * Each frequently-changing readout is its own leaf component that reads a single
 * signal, so the 104-row weapon list only re-renders when the weapon changes
 * (not every frame) — keeps it cheap and lets async icons stick.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, ComponentChildren } from 'preact';
import { BmpText } from './BmpText';
import {
  power, angle, wind, weaponIndex, playerName, teamColor, life, shield,
  blocked, winner, weapons, game, loadWeaponIcon, uiClick, showSettings, battleStatus,
  POWER_MIN, POWER_MAX, wrapAngle,
} from './store';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Element rectangles within the gui.bmp panel: [left%, top%, width%, height%].
// Measured off a gridded render of the 640x120 panel.
const R = {
  // Extents measured directly from the gui.bmp pixels (button faces + black boxes).
  list:   [0.9, 11.7, 29.1, 70.8],
  up:     [30.8, 12, 3.5, 18],   down:  [30.8, 63, 3.5, 18],
  plus:   [38.3, 16, 4.6, 19],   minus: [38.3, 62, 4.6, 18.5],
  pnum:   [38.3, 41, 5.0, 19.2],       // black readout box between +/−
  wicon:  [30.8, 34.2, 5.0, 26.7],     // 32x32 preview of the selected weapon
  meter:  [45.35, 16.3, 4.25, 64.5],   // the coloured gradient column only

  fire:   [54.8, 16.5, 15, 29.5],
  buy:    [55, 64.6, 3.2, 18], reset: [60.8, 64, 3.2, 18], help: [66.8, 64, 3.2, 18],
  aleft:  [75.5, 64, 2.7, 17], aright: [84.0, 64, 2.7, 17],
  anglen: [76.1, 66, 10, 11],          // number box, lower-centre of the dial
  close:  [94.4, 14, 3.4, 18],
  wind:   [90.6, 42.5, 7.5, 40],

  // group captions printed on the metal below each cluster (black text)
  lblWeapon: [1.5, 82, 28.5, 16],
  lblPower:  [33, 82, 17, 16],
  lblAngle:  [73, 82, 17, 16],
  lblWind:   [87.5, 82, 11, 16],
} as const;

// Square (px) box centred on the dial circle so the needle stays circular and
// pivots at the ring's centre (11.5% × 736px ≈ 61.3% × 138px ≈ 85px square).
const DIAL_BOX = [75.35, 8.6, 11.5, 61.3] as const;
// Grab layer over the dial face for drag-to-aim. Same left/width as the dial but
// stops short of the ◀/▶ buttons (top ~64%) so it never steals their clicks.
const DIAL_GRAB = [75.35, 8.6, 11.5, 52] as const;
const ANGLE_PER_PX = 0.5;   // degrees of aim per pixel of horizontal drag

// Readout ink — the panel readouts are white, like the original.
const INK = '#f4f8f4';
const LIST_FONT = 'Microsoft Sans Serif 14';   // small/thin text; row height sets the count

const pos = (r: readonly number[]): JSX.CSSProperties =>
  ({ position: 'absolute', left: `${r[0]}%`, top: `${r[1]}%`, width: `${r[2]}%`, height: `${r[3]}%` });

function Hotspot({ r, onClick, title }: { r: readonly number[]; onClick: () => void; title?: string }) {
  // Held (paused / not your turn): grey the button face and drop its pointer events.
  const off = blocked.value;
  return <button class={`ov-hotspot${off ? ' blocked' : ''}`} style={pos(r)} title={title} onClick={onClick} disabled={off} />;
}

// ---- leaf readouts (each subscribes to exactly one live signal) -------------
function ReadoutBox({ r, children }: { r: readonly number[]; children: ComponentChildren }) {
  return <div class="ov readout-box" style={pos(r)}>{children}</div>;
}

// Static black caption printed on the metal under a control cluster.
function PanelLabel({ r, text, left }: { r: readonly number[]; text: string; left?: boolean }) {
  return <div class="ov readout-box" style={{ ...pos(r), justifyContent: left ? 'flex-start' : 'center' }}><BmpText font="Microsoft Sans Serif 14" text={text} tint="#111" /></div>;
}

// The power column. Besides showing the fill it is grabbable: press anywhere on
// it and drag to set power, mapping the pointer's Y to a value (top = POWER_MAX,
// bottom = POWER_MIN). Pointer capture keeps the drag tracking even when the
// cursor slips off the narrow bar sideways.
function MeterOverlay() {
  const p = power.value;
  const emptyH = R.meter[3] * (1 - (p - POWER_MIN) / (POWER_MAX - POWER_MIN));
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const powerFromEvent = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    game().setPower(Math.round(POWER_MAX - frac * (POWER_MAX - POWER_MIN)));
  };
  const onDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    powerFromEvent(e);
    e.preventDefault();
  };
  const onMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (dragging.current) powerFromEvent(e);
  };
  const onUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <>
      <div class="ov meter-empty" style={{ position: 'absolute', left: `${R.meter[0]}%`, top: `${R.meter[1]}%`, width: `${R.meter[2]}%`, height: `${emptyH}%` }} />
      <ReadoutBox r={R.pnum}><BmpText font="Trebuchet MS 18" text={String(p)} tint={INK} /></ReadoutBox>
      <div ref={barRef} class={`ov meter-drag${blocked.value ? ' blocked' : ''}`} style={pos(R.meter)}
        title="Drag to set power (top 1000 · bottom 10)"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
    </>
  );
}
function FireButton() {
  const off = blocked.value;   // held when paused or when it's not the human's turn
  return (
    <button class={`ov fire-btn${off ? ' disabled' : ''}`} style={pos(R.fire)} disabled={off} onClick={() => { if (game().isPlayerTurn()) game().fire(); }}>
      <BmpText font="fire" text="FIRE" height={38} />
    </button>
  );
}
function Needle() {
  const a = angle.value;
  return (
    <svg class="ov dial-overlay" style={pos(DIAL_BOX)} viewBox="0 0 100 100" preserveAspectRatio="none">
      <line class="needle" x1="50" y1="50" x2="80" y2="50" transform={`rotate(${-a} 50 50)`} />
    </svg>
  );
}
function AngleReadout() {
  return <ReadoutBox r={R.anglen}><BmpText font="Microsoft Sans Serif 12" text={`${angle.value}`} tint={INK} /></ReadoutBox>;
}
// Horizontal drag over the dial scrubs the aim: drag left → aim left (angle up),
// drag right → aim right (angle down), matching the ◀/▶ buttons. Relative to the
// press point so the needle doesn't jump; pointer capture keeps it tracking when
// the cursor slips off the small dial.
function DialGrab() {
  const drag = useRef<{ x: number; a: number } | null>(null);
  const onDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, a: game().getAngle() };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) game().setAngle(wrapAngle(Math.round(d.a - (e.clientX - d.x) * ANGLE_PER_PX)));
  };
  const onUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return <div class={`ov dial-drag${blocked.value ? ' blocked' : ''}`} style={pos(DIAL_GRAB)}
    title="Drag left/right to aim"
    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />;
}
function WindReadout() {
  const w = wind.value;
  const txt = Math.abs(w) < 0.05 ? 'OFF' : `${w >= 0 ? '>' : '<'}${Math.abs(w).toFixed(1)}`;
  return <ReadoutBox r={R.wind}><BmpText font="Microsoft Sans Serif 12" text={txt} tint={INK} /></ReadoutBox>;
}

// ---- weapon list (re-renders only when the weapon changes) ------------------
function WeaponIcon({ name, size, cls }: { name: string; size: 16 | 32; cls: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let ok = true; loadWeaponIcon(name, size).then(u => { if (ok && u) setSrc(u); }); return () => { ok = false; }; }, [name, size]);
  return src ? <img class={cls} src={src} alt="" /> : <span class={cls} />;
}
// The 32x32 preview of the current weapon, in the box between the ▲/▼ arrows.
// The weapon rows/preview key off each weapon's real database `index`, not its
// position in the (possibly filtered) displayed list, so selection and highlight
// stay correct regardless of how the list is scoped.
function WeaponPreview() {
  const wp = weapons.value.find(w => w.index === weaponIndex.value) ?? weapons.value[0];
  return <div class="ov weapon-preview" style={pos(R.wicon)}>{wp && <WeaponIcon name={wp.name} size={32} cls="wbig" />}</div>;
}
function WeaponList() {
  const listRef = useRef<HTMLDivElement>(null);
  const idx = weaponIndex.value;
  useEffect(() => {
    (listRef.current?.querySelector('.wrow.active') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  return (
    <div class={`ov wlist${blocked.value ? ' blocked' : ''}`} style={pos(R.list)} ref={listRef}>
      {weapons.value.map((wp, i) => {
        const active = wp.index === idx;
        return (
          <div key={wp.name} class={`wrow${active ? ' active' : ''}`} onClick={() => { uiClick(); game().selectWeapon(wp.index); }}>
            <WeaponIcon name={wp.name} size={16} cls="wicon" />
            <BmpText class="wtext" font={LIST_FONT} text={`${i + 1}. ${wp.name}`} tint={active ? '#eaffea' : '#c8e8c8'} />
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
  // ▲/▼ step through the displayed list (by list position), then select that
  // row's real weapon index — works whether the list is full or filtered.
  const dW = (d: number) => {
    const list = weapons.value;
    if (!list.length) return;
    uiClick();
    const cur = Math.max(0, list.findIndex(w => w.index === g().getCurrentWeaponIndex()));
    g().selectWeapon(list[clamp(cur + d, 0, list.length - 1)].index);
  };

  return (
    <div id="hud-panel">
      <img class="panel-bg" src="/assets/gui/gui.bmp" alt="" />
      <WeaponList />
      <WeaponPreview />
      <Hotspot r={R.up} title="Previous weapon" onClick={() => dW(-1)} />
      <Hotspot r={R.down} title="Next weapon" onClick={() => dW(1)} />
      <Hotspot r={R.plus} title="Power up" onClick={() => dP(50)} />
      <Hotspot r={R.minus} title="Power down" onClick={() => dP(-50)} />
      <MeterOverlay />
      <FireButton />
      <Hotspot r={R.buy} title="Weapons depot" onClick={() => {}} />
      <Hotspot r={R.reset} title="Reset" onClick={() => {}} />
      <Hotspot r={R.help} title="Help" onClick={() => {}} />
      <Needle />
      <AngleReadout />
      <DialGrab />
      <Hotspot r={R.aleft} title="Aim left (+)" onClick={() => dA(2)} />
      <Hotspot r={R.aright} title="Aim right (-)" onClick={() => dA(-2)} />
      <WindReadout />
      <Hotspot r={R.close} title="Audio settings" onClick={() => { uiClick(); showSettings.value = true; }} />
      <PanelLabel r={R.lblWeapon} text="Select Weapon" left />
      <PanelLabel r={R.lblPower} text="Power" />
      <PanelLabel r={R.lblAngle} text="Angle" />
      <PanelLabel r={R.lblWind} text="Wind" />
    </div>
  );
}

// Top-left status overlay: each tank's "NAME: N% life" (team colour) then
// "Battle X of Y - Shot Z" (white) — matches the original (FUN_0048c480).
function BattleStatus() {
  const s = battleStatus.value;
  // The original's status font: BeijingSSK 16 outlined (white fill + baked black
  // outline). Rendered at NATIVE size (no tint) so it stays crisp. Only the
  // ACTIVE tank's line is boxed in its team colour.
  return (
    <div id="battle-status">
      {s.lines.map(l => (
        <div key={l.text} class={`bstat-line${l.active ? ' active' : ''}${l.dead ? ' dead' : ''}`}
          style={l.active ? { background: l.color + '66', borderColor: l.color } : undefined}>
          <BmpText font="BeijingSSK 16 outlined" text={l.text} height={18} spacing={-1} />
        </div>
      ))}
      <div class="bstat-line"><BmpText font="BeijingSSK 16 outlined" text={s.battle} height={18} spacing={-1} /></div>
    </div>
  );
}

// ---- turn banner / side LCDs -----------------------------------------------
function TurnBanner() {
  const [show, setShow] = useState(false);
  const name = playerName.value;
  const win = winner.value;
  useEffect(() => {
    if (win) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 1500);
    return () => clearTimeout(t);
  }, [name]);
  if (win) return <div id="turn-indicator" class="visible">{win} WINS!</div>;
  return <div id="turn-indicator" class={show ? 'visible' : ''}>{name}'s Turn</div>;
}

// A single bitmap-font line inside a black side box.
function LcdLine({ text, title }: { text: string; title?: boolean }) {
  return <BmpText class="lcd-line" font={title ? 'Trebuchet MS 9 bold' : 'Microsoft Sans Serif 12'} text={text} tint={title ? '#ffffff' : '#d7e4d7'} />;
}
function WeaponDetails() {
  const w = weapons.value.find(x => x.index === weaponIndex.value) ?? weapons.value[0];
  return (
    <div class="side-lcd" id="weapon-details">
      <LcdLine title text="WEAPON DETAILS" />
      {w && <>
        <LcdLine text={`TYPE ${String(w.type).toUpperCase()}`} />
        <LcdLine text={`DAMAGE ${w.damage}`} />
        <LcdLine text={`RADIUS ${w.radius}`} />
        <LcdLine text={`VARIANCE ${(w.variance ?? 0).toFixed(1)}`} />
        <LcdLine text={`CLUSTER ${w.cluNum > 0 ? w.cluNum : '-'}`} />
        <LcdLine text={`COST $${w.cost}`} />
      </>}
    </div>
  );
}
function PlayerStats() {
  return (
    <div class="side-lcd" id="player-stats">
      <LcdLine title text={playerName.value.toUpperCase()} />
      <LcdLine text={`LIFE ${life.value}/1000`} />
      <LcdLine text={`SHIELD ${shield.value}/1000`} />
    </div>
  );
}

export function Hud() {
  return (
    <>
      <BattleStatus />
      <TurnBanner />
      <div id="hud">
        <WeaponDetails />
        <ControlPanel />
        <PlayerStats />
      </div>
    </>
  );
}
