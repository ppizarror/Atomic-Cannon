/** The in-battle HUD: status bar, turn banner, and the skeuomorphic control panel. */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  power, angle, wind, weaponIndex, playerName, teamColor, life, shield, canFire,
  winner, weapons, game, loadWeaponIcon,
  POWER_MIN, POWER_MAX, ANGLE_MIN, ANGLE_MAX,
} from './store';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- top status bar ---------------------------------------------------------
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

// --- centre turn / winner banner -------------------------------------------
function TurnBanner() {
  const [show, setShow] = useState(false);
  const name = playerName.value;
  const win = winner.value;

  useEffect(() => {
    if (win) return;                       // winner banner stays until reset
    setShow(true);
    const t = setTimeout(() => setShow(false), 1500);
    return () => clearTimeout(t);
  }, [name]);

  if (win) return <div id="turn-indicator" class="visible">{win} WINS!</div>;
  return <div id="turn-indicator" class={show ? 'visible' : ''}>{name}'s Turn</div>;
}

// --- weapon icon (async colorkey load) --------------------------------------
function WeaponIcon({ name }: { name: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let ok = true; loadWeaponIcon(name).then(u => { if (ok && u) setSrc(u); }); return () => { ok = false; }; }, [name]);
  return src ? <img class="wicon" src={src} alt="" /> : <span class="wicon" />;
}

// --- weapon details LCD -----------------------------------------------------
function WeaponDetails() {
  const w = weapons.value[weaponIndex.value];
  if (!w) return <section class="mod lcd-panel" id="weapon-details" />;
  const rows: [string, string][] = [
    ['Type', String(w.type)],
    ['Damage', String(w.damage)],
    ['Radius', String(w.radius)],
    ['Variance', (w.variance ?? 0).toFixed(1)],
    ['Cluster', w.cluNum > 0 ? String(w.cluNum) : '—'],
    ['Cost', String(w.cost)],
  ];
  return (
    <section class="mod lcd-panel" id="weapon-details">
      <div class="mod-title">Weapon Details</div>
      <dl class="wd-list">
        {rows.map(([k, v]) => <div><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </section>
  );
}

// --- weapon select list -----------------------------------------------------
function WeaponSelect() {
  const listRef = useRef<HTMLDivElement>(null);
  const idx = weaponIndex.value;

  useEffect(() => {
    const row = listRef.current?.querySelector('.wrow.active') as HTMLElement | null;
    row?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const step = (d: number) => game().selectWeapon(clamp(idx + d, 0, weapons.value.length - 1));

  return (
    <section class="mod" id="weapon-select">
      <div class="wsel-body">
        <div class="lcd-panel wlist" ref={listRef}>
          {weapons.value.map((w, i) => (
            <div class={`wrow${i === idx ? ' active' : ''}`} onClick={() => game().selectWeapon(i)}>
              <span class="wnum">{i + 1}.</span>
              <WeaponIcon name={w.name} />
              <span class="wname">{w.name}</span>
            </div>
          ))}
        </div>
        <div class="wsel-arrows">
          <button class="metal-btn" onClick={() => step(-1)}>▲</button>
          <button class="metal-btn" onClick={() => step(1)}>▼</button>
        </div>
      </div>
      <div class="mod-label">Select Weapon</div>
    </section>
  );
}

// --- power ------------------------------------------------------------------
function PowerMod() {
  const p = power.value;
  const set = (v: number) => game().setPower(clamp(v, POWER_MIN, POWER_MAX));
  return (
    <section class="mod" id="power-mod">
      <div class="power-body">
        <div class="power-btns">
          <button class="metal-btn" onClick={() => set(p + 5)}>+</button>
          <div class="lcd-num">{p}</div>
          <button class="metal-btn" onClick={() => set(p - 5)}>−</button>
        </div>
        <div class="power-meter"><div class="power-fill" style={{ height: `${(p / POWER_MAX) * 100}%` }} /></div>
      </div>
      <div class="mod-label">Power</div>
    </section>
  );
}

// --- fire -------------------------------------------------------------------
function FireMod() {
  return (
    <section class="mod" id="fire-mod">
      <button id="fire-btn" disabled={!canFire.value} onClick={() => { if (canFire.value) game().fire(); }}>Fire</button>
    </section>
  );
}

// --- angle ------------------------------------------------------------------
function AngleMod() {
  const a = angle.value;
  const set = (v: number) => game().setAngle(clamp(v, ANGLE_MIN, ANGLE_MAX));
  return (
    <section class="mod" id="angle-mod">
      <div class="angle-body">
        <div class="dial">
          <svg viewBox="0 0 100 100">
            <circle class="dial-face" cx="50" cy="50" r="46" />
            <line class="needle" x1="50" y1="50" x2="92" y2="50" transform={`rotate(${-a} 50 50)`} />
            <circle class="dial-hub" cx="50" cy="50" r="5" />
          </svg>
        </div>
        <div class="angle-row">
          <button class="metal-btn" onClick={() => set(a - 2)}>◄</button>
          <span class="lcd-num">{a}°</span>
          <button class="metal-btn" onClick={() => set(a + 2)}>►</button>
        </div>
      </div>
      <div class="mod-label">Angle</div>
    </section>
  );
}

// --- wind -------------------------------------------------------------------
function WindMod() {
  const w = wind.value;
  return (
    <section class="mod" id="wind-mod">
      <div class="lcd-panel wind-box">{w >= 0 ? '→' : '←'} {Math.abs(w).toFixed(1)}</div>
      <div class="mod-label">Wind</div>
    </section>
  );
}

export function Hud() {
  return (
    <>
      <StatusBar />
      <TurnBanner />
      <div id="hud">
        <WeaponDetails />
        <WeaponSelect />
        <PowerMod />
        <FireMod />
        <AngleMod />
        <div class="hud-spacer" />
        <WindMod />
      </div>
    </>
  );
}
