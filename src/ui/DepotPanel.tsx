/**
 * Weapons Depot — the buy/sell screen. Shown above the battle HUD (via the
 * `showDepot` signal), styled to match the original: a brushed-metal panel with
 * a sortable Qty / Name / Type / Power / Cost table, green affordability rows,
 * a green tooltip (the `zeon` UI kit) describing the weapon under the cursor, and
 * Buy / Sell / Auto Buy / Stats / Close controls over a Credits readout.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  showDepot, credits, ownedCounts, mapName, weaponIndex,
  closeDepot, depotBuy, depotSell, depotAutoBuy, loadWeaponIcon, loadUiBmp, game, uiClick,
} from './store';
import { WEAPON_DATABASE, type WeaponDef } from '../core/CWeapon';

type SortKey = 'qty' | 'name' | 'type' | 'power' | 'cost';

// The depot's "Power" column. NOTE: in the original this is a derived figure that
// exceeds raw damage for some weapons (nukes/organics count their fallout, etc.);
// pending the exact formula we show base damage.
function powerOf(w: WeaponDef): number { return w.damage; }

const UNLIMITED = Number.POSITIVE_INFINITY;
const fmtQty = (n: number) => (n === UNLIMITED ? '∞' : n > 0 ? String(n) : '0');

// ---- small leaf pieces ------------------------------------------------------
function WeaponIcon({ name }: { name: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let ok = true; loadWeaponIcon(name, 16).then(u => { if (ok && u) setSrc(u); }); return () => { ok = false; }; }, [name]);
  return src ? <img class="dep-icon" src={src} alt="" /> : <span class="dep-icon" />;
}

// The magenta-keyed sort caret next to the active column header.
function SortArrow({ dir }: { dir: 1 | -1 }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let ok = true;
    loadUiBmp(`gui/sort arrow ${dir === 1 ? 'up' : 'down'}.bmp`).then(u => { if (ok && u) setSrc(u); });
    return () => { ok = false; };
  }, [dir]);
  return <img class="dep-sort" src={src} alt="" />;
}

// Green weapon tooltip (the `zeon` dialog art) — name + description, floating just
// below-right of the cursor with a small upward pointer.
function Tooltip({ w, x, y }: { w: WeaponDef; x: number; y: number }) {
  return (
    <div class="dep-tooltip" style={{ left: `${x + 16}px`, top: `${y + 18}px` }}>
      <div class="dep-tt-arrow" />
      <div class="dep-tt-name">{w.name}</div>
      <div class="dep-tt-desc">{w.desc || 'No description.'}</div>
    </div>
  );
}

// ---- the modal --------------------------------------------------------------
export function DepotPanel() {
  if (!showDepot.value) return null;

  const [sel, setSel] = useState(weaponIndex.value);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cost', dir: 1 });
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [showStats, setShowStats] = useState(false);

  const owned = ownedCounts.value;
  const creds = credits.value;

  // The catalog, sorted by the active column. Kept stable per (sort, owned) so the
  // list isn't rebuilt on every hover.
  const rows = useMemo(() => {
    const val = (w: WeaponDef): number | string => {
      switch (sort.key) {
        case 'qty': return owned[w.index] ?? 0;
        case 'name': return w.name.toLowerCase();
        case 'type': return String(w.type).toLowerCase();
        case 'power': return powerOf(w);
        case 'cost': return w.cost;
        default: return 0;
      }
    };
    return WEAPON_DATABASE.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return a.index - b.index;
    });
  }, [sort.key, sort.dir, owned]);

  const clickHeader = (key: SortKey) => {
    uiClick();
    setSort(s => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  };
  const selectRow = (i: number) => { uiClick(); setSel(i); game().selectWeapon(i); };

  const selW = WEAPON_DATABASE[sel];
  const canBuy = selW && !(owned[sel] === UNLIMITED) && creds >= selW.cost;
  const canSell = selW && !(owned[sel] === UNLIMITED) && (owned[sel] ?? 0) > 0;

  const Header = ({ k, label, cls }: { k: SortKey; label: string; cls?: string }) => (
    <button class={`dep-th ${cls ?? ''}`} onClick={() => clickHeader(k)}>
      {label}{sort.key === k && <SortArrow dir={sort.dir} />}
    </button>
  );

  return (
    <div class="dep-overlay" onClick={closeDepot}>
      <div class="dep-card" onClick={e => e.stopPropagation()}>
        <div class="dep-head">
          <div class="dep-title">WEAPONS DEPOT</div>
          <div class="dep-sub">CLICK A WEAPON FOR ITS DESCRIPTION</div>
        </div>

        <div class="dep-cols">
          <Header k="qty" label="Qty" cls="c-qty" />
          <Header k="name" label="Name" cls="c-name" />
          <Header k="type" label="Type" cls="c-type" />
          <Header k="power" label="Power" cls="c-num" />
          <Header k="cost" label="Cost" cls="c-num" />
        </div>

        <div class="dep-list" onMouseMove={e => setPos({ x: e.clientX, y: e.clientY })}>
          {rows.map(w => {
            const q = owned[w.index] ?? 0;
            const affordable = q === UNLIMITED || creds >= w.cost;
            return (
              <div
                key={w.index}
                class={`dep-row${w.index === sel ? ' sel' : ''}${affordable ? ' afford' : ' broke'}`}
                onClick={() => selectRow(w.index)}
                onMouseEnter={() => setHover(w.index)}
                onMouseLeave={() => setHover(h => (h === w.index ? null : h))}
              >
                <span class="c-qty">{fmtQty(q)}</span>
                <span class="c-name"><WeaponIcon name={w.name} /><span class="dep-nm">{w.name}</span></span>
                <span class="c-type">{w.type}</span>
                <span class="c-num">{powerOf(w)}</span>
                <span class="c-num">{w.cost}</span>
              </div>
            );
          })}
        </div>

        {hover !== null && WEAPON_DATABASE[hover] && <Tooltip w={WEAPON_DATABASE[hover]} x={pos.x} y={pos.y} />}
        {showStats && selW && (
          <div class="dep-stats" onClick={() => setShowStats(false)}>
            <div class="dep-tt-name">{selW.name}</div>
            <div class="dep-stat-grid">
              <span>Type</span><span>{selW.type}</span>
              <span>Damage</span><span>{selW.damage}</span>
              <span>Radius</span><span>{selW.radius}</span>
              <span>Variance</span><span>{(selW.variance ?? 0).toFixed(1)}</span>
              <span>Cluster</span><span>{selW.cluNum > 0 ? selW.cluNum : '—'}</span>
              <span>Cost</span><span>${selW.cost}</span>
              <span>Owned</span><span>{fmtQty(owned[sel] ?? 0)}</span>
            </div>
            <div class="dep-hint">click to close</div>
          </div>
        )}

        <div class="dep-foot">
          <div class="dep-money">
            <div class="dep-map">{mapName.value}</div>
            <div class="dep-credits">Credits {creds}</div>
          </div>
          <div class="dep-btns">
            <button class="dep-btn" disabled={!canBuy} onClick={() => depotBuy(sel)}>Buy</button>
            <button class="dep-btn" disabled={!canSell} onClick={() => depotSell(sel)}>Sell</button>
            <button class="dep-btn wide" onClick={depotAutoBuy}>Auto Buy</button>
            <button class="dep-btn" onClick={() => { uiClick(); setShowStats(s => !s); }}>Stats</button>
            <button class="dep-btn" onClick={closeDepot}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
