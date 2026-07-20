/**
 * In-battle HUD. The control panel is the original `gui.bmp` sprite; live content
 * (weapon list, power fill, FIRE, angle needle, wind) and click hotspots are
 * positioned over it as a percentage of the 640x120 panel.
 *
 * Each frequently-changing readout is its own leaf component that reads a single
 * signal, so the 104-row weapon list only re-renders when the weapon changes
 * (not every frame) — keeps it cheap and lets async icons stick.
 */
import {useEffect, useRef, useState} from 'preact/hooks';
import type {JSX, ComponentChildren} from 'preact';
import {BmpText} from './BmpText';
import {
    power, angle, wind, weaponIndex, playerName, teamColor, life, maxLife, shield,
    blocked, winner, weapons, game, loadWeaponIcon, uiClick, battleStatus,
    openDepot, openPauseMenu, openHelp, POWER_MIN, POWER_MAX, wrapAngle, turnTimer,
    teamId, armor, hazmat, posX, posY, credits, windVelX, windVelY, windAccX, windAccY, canMoveNow,
} from './store';
import {weaponPower, weaponDamagePerArea} from '../core/CWeapon';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Element rectangles within the gui.bmp panel: [left%, top%, width%, height%].
// Measured off a gridded render of the 640x120 panel.
const R = {
    // Extents measured directly from the gui.bmp pixels (button faces + black boxes).
    list: [0.9, 11.7, 29.1, 70.8],
    up: [30.8, 12, 3.5, 18], down: [30.8, 63, 3.5, 18],
    plus: [38.3, 16, 4.6, 19], minus: [38.3, 62, 4.6, 18.5],
    pnum: [38.3, 41, 5.0, 19.2],       // black readout box between +/−
    wicon: [30.8, 34.2, 5.0, 26.7],     // 32x32 preview of the selected weapon
    meter: [45.35, 16.3, 4.25, 64.5],   // the coloured gradient column only

    fire: [54.8, 16.5, 15, 29.5],
    timer: [54.7, 50, 14.6, 3.4],    // shot-time bar (thin), just below FIRE
    buy: [55, 64.6, 3.2, 18], reset: [60.8, 64, 3.2, 18], help: [66.8, 64, 3.2, 18],
    aleft: [75.5, 64, 2.7, 17], aright: [84.0, 64, 2.7, 17],
    anglen: [76.1, 66, 10, 11],          // number box, lower-centre of the dial
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
const ANGLE_PER_PX = 0.5;   // degrees of aim per pixel of horizontal drag

// Readout ink — the panel readouts are white, like the original.
const INK = '#f4f8f4';

const pos = (r: readonly number[]): JSX.CSSProperties =>
    ({position: 'absolute', left: `${r[0]}%`, top: `${r[1]}%`, width: `${r[2]}%`, height: `${r[3]}%`});

function Hotspot({r, onClick, title}: { r: readonly number[]; onClick: () => void; title?: string }) {
    // Held (paused / not your turn): grey the button face and drop its pointer events.
    const off = blocked.value;
    return <button class={`ov-hotspot${off ? ' blocked' : ''}`} style={pos(r)} title={title} onClick={onClick}
                   disabled={off}/>;
}

// ---- leaf readouts (each subscribes to exactly one live signal) -------------
function ReadoutBox({r, children}: { r: readonly number[]; children: ComponentChildren }) {
    return <div class="ov readout-box" style={pos(r)}>{children}</div>;
}

// Static black caption printed on the metal under a control cluster.
function PanelLabel({r, text, left}: { r: readonly number[]; text: string; left?: boolean }) {
    return <div class="ov readout-box" style={{...pos(r), justifyContent: left ? 'flex-start' : 'center'}}><BmpText
        font="msans-14" text={text} tint="#111"/></div>;
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
            <div class="ov meter-empty" style={{
                position: 'absolute',
                left: `${R.meter[0]}%`,
                top: `${R.meter[1]}%`,
                width: `${R.meter[2]}%`,
                height: `${emptyH}%`
            }}/>
            <ReadoutBox r={R.pnum}><BmpText font="trebuchet-18" text={String(p)} tint={INK}/></ReadoutBox>
            <div ref={barRef} class={`ov meter-drag${blocked.value ? ' blocked' : ''}`} style={pos(R.meter)}
                 title="Drag to set power (top 1000 · bottom 10)"
                 onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}/>
        </>
    );
}

function FireButton() {
    const off = blocked.value;   // held when paused or when it's not the human's turn
    return (
        <button class={`ov fire-btn${off ? ' disabled' : ''}`} style={pos(R.fire)} disabled={off} onClick={() => {
            if (game().isPlayerTurn()) game().fire();
        }}>
            <BmpText font="fire" text="FIRE" height={38}/>
        </button>
    );
}

// The shot-time bar below FIRE: a fixed red end-cap on the left, then a track
// whose green fill drains right→left as the turn clock runs down, shading
// green→yellow→red (RE: the shot-time frame in FUN_00474ff0). Hidden (null)
// whenever there's no active countdown.
function TurnTimerBar() {
    const t = turnTimer.value;
    if (!t) return null;
    return (
        <div class="ov turn-timer" style={pos(R.timer)}>
            <div class="tt-cap"/>
            <div class="tt-track">
                <div class="tt-fill" style={{width: `${t.frac * 100}%`, background: t.color}}/>
            </div>
        </div>
    );
}

function Needle() {
    const a = angle.value;
    return (
        <svg class="ov dial-overlay" style={pos(DIAL_BOX)} viewBox="0 0 100 100" preserveAspectRatio="none">
            <line class="needle" x1="50" y1="50" x2="80" y2="50" transform={`rotate(${-a} 50 50)`}/>
        </svg>
    );
}

function AngleReadout() {
    return <ReadoutBox r={R.anglen}><BmpText font="msans-12" text={`${angle.value}`} tint={INK}/></ReadoutBox>;
}

// Horizontal drag over the dial scrubs the aim: drag left → aim left (angle up),
// drag right → aim right (angle down), matching the ◀/▶ buttons. Relative to the
// press point so the needle doesn't jump; pointer capture keeps it tracking when
// the cursor slips off the small dial.
function DialGrab() {
    const drag = useRef<{ x: number; a: number } | null>(null);
    const onDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
        drag.current = {x: e.clientX, a: game().getAngle()};
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
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}/>;
}

function WindReadout() {
    const w = wind.value;
    const txt = Math.abs(w) < 0.05 ? 'OFF' : `${w >= 0 ? '>' : '<'}${Math.abs(w).toFixed(1)}`;
    return <ReadoutBox r={R.wind}><BmpText font="msans-12" text={txt} tint={INK}/></ReadoutBox>;
}

// ---- weapon list (re-renders only when the weapon changes) ------------------
function WeaponIcon({name, size, cls}: { name: string; size: 16 | 32; cls: string }) {
    const [src, setSrc] = useState('');
    useEffect(() => {
        let ok = true;
        loadWeaponIcon(name, size).then(u => {
            if (ok && u) setSrc(u);
        });
        return () => {
            ok = false;
        };
    }, [name, size]);
    return src ? <img class={cls} src={src} alt=""/> : <span class={cls}/>;
}

// The 32x32 preview of the current weapon, in the box between the ▲/▼ arrows.
// The weapon rows/preview key off each weapon's real database `index`, not its
// position in the (possibly filtered) displayed list, so selection and highlight
// stay correct regardless of how the list is scoped.
function WeaponPreview() {
    const wp = weapons.value.find(w => w.index === weaponIndex.value) ?? weapons.value[0];
    return <div class="ov weapon-preview" style={pos(R.wicon)}>{wp &&
        <WeaponIcon name={wp.name} size={32} cls="wbig"/>}</div>;
}

function WeaponList() {
    const listRef = useRef<HTMLDivElement>(null);
    const idx = weaponIndex.value;
    useEffect(() => {
        (listRef.current?.querySelector('.wrow.active') as HTMLElement | null)?.scrollIntoView({block: 'nearest'});
    }, [idx]);
    return (
        <div class={`ov wlist${blocked.value ? ' blocked' : ''}`} style={pos(R.list)} ref={listRef}>
            {weapons.value.map((wp, i) => {
                const active = wp.index === idx;
                return (
                    <div key={wp.name} class={`wrow${active ? ' active' : ''}`} onClick={() => {
                        uiClick();
                        game().selectWeapon(wp.index);
                    }}>
                        <WeaponIcon name={wp.name} size={16} cls="wicon"/>
                        <BmpText class="wtext" font="beijing-16-out" text={`${i + 1}. ${wp.name}`} spacing={-1}/>
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
    // row's real weapon index — works whether the list is full or filtered. Wraps
    // around: ▼ off the last row jumps to the first, ▲ off the first to the last.
    const dW = (d: number) => {
        const list = weapons.value;
        if (!list.length) return;
        uiClick();
        const cur = Math.max(0, list.findIndex(w => w.index === g().getCurrentWeaponIndex()));
        const next = (((cur + d) % list.length) + list.length) % list.length;
        g().selectWeapon(list[next].index);
    };

    return (
        <div id="hud-panel">
            <img class="panel-bg" src="/assets/gui/gui.bmp" alt=""/>
            <WeaponList/>
            <WeaponPreview/>
            <Hotspot r={R.up} title="Previous weapon" onClick={() => dW(-1)}/>
            <Hotspot r={R.down} title="Next weapon" onClick={() => dW(1)}/>
            <Hotspot r={R.plus} title="Power up" onClick={() => dP(50)}/>
            <Hotspot r={R.minus} title="Power down" onClick={() => dP(-50)}/>
            <MeterOverlay/>
            <FireButton/>
            <TurnTimerBar/>
            <Hotspot r={R.buy} title="Weapons depot" onClick={openDepot}/>
            <Hotspot r={R.reset} title="Reset to last shot" onClick={() => {
                uiClick();
                game().resetAim();
            }}/>
            <Hotspot r={R.help} title="Help" onClick={openHelp}/>
            <Needle/>
            <AngleReadout/>
            <DialGrab/>
            <Hotspot r={R.aleft} title="Aim left (+)" onClick={() => dA(2)}/>
            <Hotspot r={R.aright} title="Aim right (-)" onClick={() => dA(-2)}/>
            <WindReadout/>
            <Hotspot r={R.close} title="Menu" onClick={openPauseMenu}/>
            <PanelLabel r={R.lblWeapon} text="Select Weapon" left/>
            <PanelLabel r={R.lblPower} text="Power"/>
            <PanelLabel r={R.lblAngle} text="Angle"/>
            <PanelLabel r={R.lblWind} text="Wind"/>
        </div>
    );
}

// Top-left status overlay: each tank's "NAME: N% life" (team colour) then
// "Battle X of Y - Shot Z" (white) — matches the original (FUN_0048c480).
function BattleStatus() {
    const s = battleStatus.value;
    return (
        <div id="battle-status">
            {s.lines.map((l, i) => (
                // Key by slot, NOT by text — keying on the text remounts the line (and its
                // canvas) on every life change, which flashes an undrawn canvas. Redraw in place.
                <div key={i} class={`bstat-line${l.active ? ' active' : ''}${l.dead ? ' dead' : ''}`}
                     style={l.active ? {background: l.color + '66', borderColor: l.color} : undefined}>
                    <BmpText font="beijing-16-out" text={l.text} height={18} spacing={-1}/>
                </div>
            ))}
            <div class="bstat-line"><BmpText font="beijing-16-out" text={s.battle} height={18} spacing={-1}/></div>
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
function LcdLine({text}: { text: string; title?: boolean }) {
    return <BmpText class="lcd-line" font="silkscreen-8-white" text={text} spacing={3}/>;
}

/** The currently-selected weapon def (falls back to the first). */
function currentWeapon() {
    return weapons.value.find(x => x.index === weaponIndex.value) ?? weapons.value[0];
}

// The side-LCD boxes flank the central control panel, like the original HUD
// painter (FUN_00474ff0): two weapon boxes to the LEFT, two tank/world boxes to
// the RIGHT. Each is appended outward only when the screen is wide enough to hold
// it (the width-gating lives in hud.css, revealing outermost boxes last). The
// field set and every derived value is reversed from the binary. (The original's
// third left box — "Weapon Desc" — is omitted: most weapons carry no description.)

// L1 — WEAPON DETAILS (innermost left). Power + Damage-per-area are DERIVED stats
// (see weaponPower/weaponDamagePerArea); Fodder is the raw fraction shown as a %.
function WeaponDetails1() {
    const w = currentWeapon();
    return (
        <div class="side-lcd wpn" id="weapon-details">
            <LcdLine title text="WEAPON DETAILS"/>
            {w && <>
                <LcdLine text={`TYPE ${String(w.type).toUpperCase()}`}/>
                <LcdLine text={`POWER ${weaponPower(w)}`}/>
                <LcdLine text={`DAMAGE ${w.damage}`}/>
                <LcdLine text={`RADIUS ${w.radius}`}/>
                <LcdLine text={`VARIANCE ${(w.variance ?? 0).toFixed(1)}`}/>
                <LcdLine text={`FODDER ${Math.round((w.fodder ?? 0) * 100)}%`}/>
                <LcdLine text={`DAMAGE PER AREA ${weaponDamagePerArea(w)}`}/>
            </>}
        </div>
    );
}

// L2 — WEAPON DETAILS (second left). Cluster = total submunitions cluNum^cluRecurse
// (raw cluNum when it doesn't recurse); Succession is stored+1; Radiation is the
// binary's irDmg·fodder·radius·100 rating (all RE: FUN_00474ff0 @ 0x47b9c7..).
function WeaponDetails2() {
    const w = currentWeapon();
    const cluster = w ? ((w.cluRecurse ?? 0) > 0 ? Math.pow(Math.trunc(w.cluNum), Math.trunc(w.cluRecurse)) : (w.cluNum ?? 0)) : 0;
    return (
        <div class="side-lcd wpn" id="weapon-details-2">
            <LcdLine title text="WEAPON DETAILS"/>
            {w && <>
                <LcdLine text={`EARTH ${w.earth ?? 0}`}/>
                <LcdLine text={`SPAWN ${w.spawn ?? 0}`}/>
                <LcdLine text={`CLUSTER ${cluster}`}/>
                <LcdLine text={`SUCCESSION ${(w.sucNum ?? 0) + 1}`}/>
                <LcdLine text={`BATTERY ${w.batSec ?? 0}`}/>
                <LcdLine text={`RADIATION ${Math.round((w.irDmg ?? 0) * (w.fodder ?? 0) * w.radius * 100)}`}/>
            </>}
        </div>
    );
}

// R1 — tank stats (innermost right), titled with the acting tank's name.
function PlayerStats() {
    return (
        <div class="side-lcd" id="player-stats">
            <LcdLine title text={playerName.value.toUpperCase()}/>
            <LcdLine text={`TEAM ${teamId.value}`}/>
            <LcdLine text={`LIFE ${life.value}/${maxLife.value}`}/>
            <LcdLine text={`SHIELD ${shield.value}/1000`}/>
            <LcdLine text={`ARMOR ${armor.value}%`}/>
            <LcdLine text={`HAZMAT ${hazmat.value}%`}/>
            <LcdLine text={`CREDITS ${credits.value}`}/>
            <LcdLine text={`POSITION ${posX.value} ${posY.value}`}/>
        </div>
    );
}

// R2 — WIND MEASUREMENTS (outermost right): wind velocity + acceleration and
// whether the acting tank is free to move (else it's stuck underground).
function WindMeasurements() {
    const f = (n: number) => n.toFixed(2);
    return (
        <div class="side-lcd" id="wind-measurements">
            <LcdLine title text="WIND MEASUREMENTS"/>
            <LcdLine text={`VEL ${f(windVelX.value)} ${f(windVelY.value)}`}/>
            <LcdLine text={`ACC ${f(windAccX.value)} ${f(windAccY.value)}`}/>
            {canMoveNow.value
                ? <LcdLine text="CAN MOVE"/>
                : <>
                    <LcdLine text="CAN'T MOVE"/>
                    <LcdLine text="UNDERGROUND"/>
                </>}
        </div>
    );
}

export function Hud() {
    return (
        <>
            <BattleStatus/>
            <TurnBanner/>
            <div id="hud">
                <WeaponDetails2/>
                <WeaponDetails1/>
                <ControlPanel/>
                <PlayerStats/>
                <WindMeasurements/>
            </div>
        </>
    );
}
