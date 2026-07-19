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
  power, angle, wind, weaponIndex, playerName, teamColor, life, shield, canFire,
  winner, weapons, game, loadWeaponIcon,
  POWER_MIN, POWER_MAX, ANGLE_MIN, ANGLE_MAX,
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
  buy:    [54.7, 65, 3.5, 18], reset: [60.7, 64, 3.5, 18], help: [66.5, 64, 3.5, 18],
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

// Square (px) box over the round dial so the needle stays circular.
const DIAL_BOX = [76.3, 4.4, 11.5, 61.3] as const;

// Readout ink — the panel readouts are white, like the original.
const INK = '#f4f8f4';
const LIST_FONT = 'Microsoft Sans Serif 14';   // small/thin text; row height sets the count

const pos = (r: readonly number[]): JSX.CSSProperties =>
  ({ position: 'absolute', left: `${r[0]}%`, top: `${r[1]}%`, width: `${r[2]}%`, height: `${r[3]}%` });

function Hotspot({ r, onClick, title }: { r: readonly number[]; onClick: () => void; title?: string }) {
  return <button class="ov-hotspot" style={pos(r)} title={title} onClick={onClick} />;
}

// ---- leaf readouts (each subscribes to exactly one live signal) -------------
function ReadoutBox({ r, children }: { r: readonly number[]; children: ComponentChildren }) {
  return <div class="ov readout-box" style={pos(r)}>{children}</div>;
}

// Static black caption printed on the metal under a control cluster.
function PanelLabel({ r, text, left }: { r: readonly number[]; text: string; left?: boolean }) {
  return <div class="ov readout-box" style={{ ...pos(r), justifyContent: left ? 'flex-start' : 'center' }}><BmpText font="Microsoft Sans Serif 14" text={text} tint="#111" /></div>;
}

function MeterOverlay() {
  const p = power.value;
  const emptyH = R.meter[3] * (1 - (p - POWER_MIN) / (POWER_MAX - POWER_MIN));
  return (
    <>
      <div class="ov meter-empty" style={{ position: 'absolute', left: `${R.meter[0]}%`, top: `${R.meter[1]}%`, width: `${R.meter[2]}%`, height: `${emptyH}%` }} />
      <ReadoutBox r={R.pnum}><BmpText font="Trebuchet MS 18" text={String(p)} tint={INK} /></ReadoutBox>
    </>
  );
}
function FireButton() {
  const on = canFire.value;
  return (
    <button class={`ov fire-btn${on ? '' : ' disabled'}`} style={pos(R.fire)} onClick={() => { if (game().isPlayerTurn()) game().fire(); }}>
      <BmpText font="fire" text="FIRE" height={38} />
    </button>
  );
}
function Needle() {
  const a = angle.value;
  const b = 41;
  return (
    <svg class="ov dial-overlay" style={pos(DIAL_BOX)} viewBox="0 0 100 100" preserveAspectRatio="none">
      <line class="needle" x1={`${b}`} y1={`${b}`} x2="84" y2={`${b}`} transform={`rotate(${-a} 50 50)`} />
    </svg>
  );
}
function AngleReadout() {
  return <ReadoutBox r={R.anglen}><BmpText font="Microsoft Sans Serif 12" text={`${angle.value}`} tint={INK} /></ReadoutBox>;
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
function WeaponPreview() {
  const wp = weapons.value[weaponIndex.value];
  return <div class="ov weapon-preview" style={pos(R.wicon)}>{wp && <WeaponIcon name={wp.name} size={32} cls="wbig" />}</div>;
}
function WeaponList() {
  const listRef = useRef<HTMLDivElement>(null);
  const idx = weaponIndex.value;
  useEffect(() => {
    (listRef.current?.querySelector('.wrow.active') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  return (
    <div class="ov wlist" style={pos(R.list)} ref={listRef}>
      {weapons.value.map((wp, i) => {
        const active = i === idx;
        return (
          <div key={wp.name} class={`wrow${active ? ' active' : ''}`} onClick={() => game().selectWeapon(i)}>
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
  const dA = (d: number) => g().setAngle(clamp(g().getAngle() + d, ANGLE_MIN, ANGLE_MAX));
  const dW = (d: number) => g().selectWeapon(clamp(g().getCurrentWeaponIndex() + d, 0, weapons.value.length - 1));

  return (
    <div id="hud-panel">
      <img class="panel-bg" src="/assets/gui/gui.bmp" alt="" />
      <WeaponList />
      <WeaponPreview />
      <Hotspot r={R.up} title="Previous weapon" onClick={() => dW(-1)} />
      <Hotspot r={R.down} title="Next weapon" onClick={() => dW(1)} />
      <Hotspot r={R.plus} title="Power up" onClick={() => dP(5)} />
      <Hotspot r={R.minus} title="Power down" onClick={() => dP(-5)} />
      <MeterOverlay />
      <FireButton />
      <Hotspot r={R.buy} title="Weapons depot" onClick={() => {}} />
      <Hotspot r={R.reset} title="Reset" onClick={() => {}} />
      <Hotspot r={R.help} title="Help" onClick={() => {}} />
      <Needle />
      <AngleReadout />
      <Hotspot r={R.aleft} title="Angle -" onClick={() => dA(-2)} />
      <Hotspot r={R.aright} title="Angle +" onClick={() => dA(2)} />
      <WindReadout />
      <Hotspot r={R.close} title="Menu" onClick={() => {}} />
      <PanelLabel r={R.lblWeapon} text="Select Weapon" left />
      <PanelLabel r={R.lblPower} text="Power" />
      <PanelLabel r={R.lblAngle} text="Angle" />
      <PanelLabel r={R.lblWind} text="Wind" />
    </div>
  );
}

// ---- status bar / banner / side LCDs ---------------------------------------
function StatusBar() {
  return (
    <div id="status-bar">
      <div class="player-info" style={{ color: teamColor.value }}>{playerName.value}</div>
      <div class="player-info tank-health">
        <span>Life:</span>
        <div class="health-bar"><div class="health-fill life-fill" style={{ width: `${life.value / 10}%` }} /></div>
        <span>Shield:</span>
        <div class="health-bar"><div class="health-fill shield-fill" style={{ width: `${shield.value / 10}%` }} /></div>
      </div>
    </div>
  );
}
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
  const w = weapons.value[weaponIndex.value];
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
      <StatusBar />
      <TurnBanner />
      <div id="hud">
        <WeaponDetails />
        <ControlPanel />
        <PlayerStats />
      </div>
    </>
  );
}
