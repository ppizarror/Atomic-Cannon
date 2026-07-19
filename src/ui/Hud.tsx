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
import type { JSX } from 'preact';
import {
  power, angle, wind, weaponIndex, playerName, teamColor, life, shield, canFire,
  winner, weapons, game, loadWeaponIcon,
  POWER_MIN, POWER_MAX, ANGLE_MIN, ANGLE_MAX,
} from './store';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Element rectangles within the gui.bmp panel: [left%, top%, width%, height%].
const R = {
  list:   [1.0, 5, 25.5, 88],
  up:     [27, 6, 5, 30],  down:  [27, 64, 5, 30],
  plus:   [32.5, 6, 6, 30], minus: [32.5, 64, 6, 30],
  meter:  [38.8, 7, 4.0, 85],
  fire:   [44.5, 14, 23, 30],
  buy:    [45.5, 62, 5, 27], reset: [52, 62, 5, 27], help: [58.5, 62, 5, 27],
  aleft:  [70.4, 77, 4.5, 18], aright: [79, 77, 4.5, 18],
  anglen: [72, 63, 9, 15],
  close:  [93.7, 5, 5, 27],
  wind:   [92, 48, 7, 42],
} as const;
const DIAL_BOX = [70.9, 7, 11.25, 60] as const;

const pos = (r: readonly number[]): JSX.CSSProperties =>
  ({ position: 'absolute', left: `${r[0]}%`, top: `${r[1]}%`, width: `${r[2]}%`, height: `${r[3]}%` });

function Hotspot({ r, onClick, title }: { r: readonly number[]; onClick: () => void; title?: string }) {
  return <button class="ov-hotspot" style={pos(r)} title={title} onClick={onClick} />;
}

// ---- leaf readouts (each subscribes to exactly one live signal) -------------
function MeterOverlay() {
  const p = power.value;
  const emptyH = R.meter[3] * (1 - p / POWER_MAX);
  return (
    <>
      <div class="ov meter-empty" style={{ position: 'absolute', left: `${R.meter[0]}%`, top: `${R.meter[1]}%`, width: `${R.meter[2]}%`, height: `${emptyH}%` }} />
      <div class="ov readout meter-num" style={pos(R.meter)}>{p}</div>
    </>
  );
}
function FireButton() {
  const on = canFire.value;
  return <button class={`ov fire-btn${on ? '' : ' disabled'}`} style={pos(R.fire)} onClick={() => { if (game().isPlayerTurn()) game().fire(); }}>FIRE</button>;
}
function Needle() {
  const a = angle.value;
  return (
    <svg class="ov dial-overlay" style={pos(DIAL_BOX)} viewBox="0 0 100 100" preserveAspectRatio="none">
      <line class="needle" x1="50" y1="50" x2="90" y2="50" transform={`rotate(${-a} 50 50)`} />
    </svg>
  );
}
function AngleReadout() { return <div class="ov readout angle-num" style={pos(R.anglen)}>{angle.value}°</div>; }
function WindReadout() { const w = wind.value; return <div class="ov readout wind-num" style={pos(R.wind)}>{w >= 0 ? '→' : '←'}{Math.abs(w).toFixed(1)}</div>; }

// ---- weapon list (re-renders only when the weapon changes) ------------------
function WeaponIcon({ name }: { name: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let ok = true; loadWeaponIcon(name).then(u => { if (ok && u) setSrc(u); }); return () => { ok = false; }; }, [name]);
  return src ? <img class="wicon" src={src} alt="" /> : <span class="wicon" />;
}
function WeaponList() {
  const listRef = useRef<HTMLDivElement>(null);
  const idx = weaponIndex.value;
  useEffect(() => {
    (listRef.current?.querySelector('.wrow.active') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  return (
    <div class="ov wlist" style={pos(R.list)} ref={listRef}>
      {weapons.value.map((wp, i) => (
        <div key={wp.name} class={`wrow${i === idx ? ' active' : ''}`} onClick={() => game().selectWeapon(i)}>
          <span class="wnum">{i + 1}.</span>
          <WeaponIcon name={wp.name} />
          <span class="wname">{wp.name}</span>
        </div>
      ))}
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
function LcdRow({ k, v }: { k: string; v: string }) { return <div><dt>{k}</dt><dd>{v}</dd></div>; }
function WeaponDetails() {
  const w = weapons.value[weaponIndex.value];
  return (
    <div class="side-lcd" id="weapon-details">
      <div class="side-title">Weapon Details</div>
      {w && (
        <dl class="wd-list">
          <LcdRow k="Type" v={String(w.type)} />
          <LcdRow k="Damage" v={String(w.damage)} />
          <LcdRow k="Radius" v={String(w.radius)} />
          <LcdRow k="Variance" v={(w.variance ?? 0).toFixed(1)} />
          <LcdRow k="Cluster" v={w.cluNum > 0 ? String(w.cluNum) : '—'} />
          <LcdRow k="Cost" v={String(w.cost)} />
        </dl>
      )}
    </div>
  );
}
function PlayerStats() {
  return (
    <div class="side-lcd" id="player-stats">
      <div class="side-title" style={{ color: teamColor.value }}>{playerName.value}</div>
      <dl class="wd-list">
        <LcdRow k="Life" v={`${life.value}/1000`} />
        <LcdRow k="Shield" v={`${shield.value}/1000`} />
      </dl>
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
