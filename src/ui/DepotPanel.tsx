/**
 * Weapons Depot — the buy/sell screen. Shown above the battle HUD (via the
 * `showDepot` signal): a brushed-metal panel, the
 * game's own bitmap fonts, a sortable Qty / Name / Type / Power / Cost table with
 * green affordability rows, a green tooltip (the `zeon` UI kit) describing the
 * weapon under the cursor, and Buy / Sell / Auto Buy / Stats / Close controls
 * (the metal button art) over a Credits readout.
 */
import {useMemo, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {Tooltip} from './Tooltip';
import {ClassicScrollbar} from './ClassicScrollbar';
import {useAsyncImage} from './useAsyncImage';
import {ModalButton} from './ModalButton';
import {
  showDepot,
  credits,
  ownedCounts,
  playerName,
  weaponIndex,
  closeDepot,
  depotBuy,
  depotSell,
  depotAutoBuy,
  loadUiBmp,
  game,
  uiClick,
} from './store';
import {WeaponIcon} from './WeaponIcon';
import {
  WEAPON_DATABASE,
  getDefaultWeaponIndex,
  weaponPower,
  weaponDamagePerArea,
  type WeaponDef,
} from '../core/CWeapon';
import {weaponEnabled} from '../core/CGameContent';
import {UNLIMITED} from '../core/CEconomy';

type SortKey = 'qty' | 'name' | 'type' | 'power' | 'cost';

// The game's bitmap fonts — catalog ids (see FONTS in BitmapFont.ts).
const TITLE_FONT = 'bazouk-28'; // native white+outline
const TABLE_FONT = 'beijing-16-out'; // table header + rows: native white + baked outline
const ROW_FONT = 'msans-14';
const SMALL_FONT = 'msans-12';
const BIG_FONT = 'msans-18';
const SUB_FONT = 'arial-14-out'; // header subtitle: native white + baked outline
const STATUS_FONT = 'beijing-16-out'; // footer player name + credits (native outline)

// The depot's "Power" figure is the weapon's derived Power stat (base damage ×
// effective impact count, +200 for radioactive weapons, raw stat for utilities) —
// see `weaponPower` in CWeapon.ts.
const powerOf = weaponPower;

// ---- small leaf pieces ------------------------------------------------------
// The magenta-keyed sort caret next to the active column header. Keeps a fixed-size
// placeholder while the bitmap loads so nothing reflows and no broken-image glyph shows.
function SortArrow({dir}: {dir: 1 | -1}) {
  const src = useAsyncImage(
    () => loadUiBmp(`gui/sort arrow ${dir === 1 ? 'up' : 'down'}.bmp`),
    [dir],
  );
  return src ? <img class="dep-sort" src={src} alt="" /> : <span class="dep-sort" />;
}

// A sortable column header. Defined at MODULE scope (not inside DepotPanel) so it
// keeps a stable component identity across re-renders — otherwise every mouse-move
// (which repositions the tooltip) would remount the header and blank the sort arrow.
function Header({
  k,
  label,
  cls,
  activeKey,
  dir,
  onSort,
}: {
  k: SortKey;
  label: string;
  cls?: string;
  activeKey: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
}) {
  return (
    <button class={`dep-th ${cls ?? ''}`} onClick={() => onSort(k)}>
      <BmpText font={TABLE_FONT} text={label} spacing={-1} />
      {activeKey === k && <SortArrow dir={dir} />}
    </button>
  );
}

// Green weapon tooltip — the shared <Tooltip> (zeon frame + tail), title = weapon
// name, content = its description, floating ABOVE the cursor with its tail aimed down.
function WeaponTip({w, x, y}: {w: WeaponDef; x: number; y: number}) {
  return (
    <div class="dep-tooltip" style={{left: `${x + 12}px`, top: `${y - 14}px`}}>
      <Tooltip
        title={w.name}
        content={w.desc || 'No description available.'}
        tailLeft="14px"
        tipPosition="down"
      />
    </div>
  );
}

// A metal action button (the game's button art) with a bitmap-font label.
function DepBtn({
  label,
  onClick,
  disabled,
  span,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  span?: boolean;
}) {
  return (
    <ModalButton
      label={label}
      onClick={onClick}
      disabled={disabled}
      class={`dep-btn${span ? ' span' : ''}`}
    />
  );
}

// ---- the modal --------------------------------------------------------------
export function DepotPanel() {
  if (!showDepot.value) return null;

  const [sel, setSel] = useState(weaponIndex.value);
  const [sort, setSort] = useState<{key: SortKey; dir: 1 | -1}>({key: 'cost', dir: 1});
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState({x: 0, y: 0});
  const [showStats, setShowStats] = useState(false);

  const owned = ownedCounts.value;
  const creds = credits.value;

  // The catalog, sorted by the active column. Rebuilt only when sort/owned change.
  const rows = useMemo(() => {
    const val = (w: WeaponDef): number | string => {
      switch (sort.key) {
        case 'qty':
          return owned[w.index] ?? 0;
        case 'name':
          return w.name.toLowerCase();
        case 'type':
          return String(w.type).toLowerCase();
        case 'power':
          return powerOf(w);
        case 'cost':
          return w.cost;
        default:
          return 0;
      }
    };
    const staple = getDefaultWeaponIndex();
    return WEAPON_DATABASE.slice()
      .filter(w => w.index === staple || weaponEnabled(w.index)) // hide disabled (Game Content)
      .sort((a, b) => {
        const va = val(a),
          vb = val(b);
        if (va < vb) return -sort.dir;
        if (va > vb) return sort.dir;
        return a.index - b.index;
      });
  }, [sort.key, sort.dir, owned]);

  const clickHeader = (key: SortKey) => {
    uiClick();
    setSort(s => (s.key === key ? {key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1} : {key, dir: 1}));
  };
  const selectRow = (i: number) => {
    uiClick();
    setSel(i);
    game().selectWeapon(i);
  };

  const selW = WEAPON_DATABASE[sel];
  const canBuy = !!selW && owned[sel] !== UNLIMITED && creds >= selW.cost;
  const canSell = !!selW && owned[sel] !== UNLIMITED && (owned[sel] ?? 0) > 0;

  return (
    <div class="overlay dep-overlay" onClick={closeDepot}>
      <div class="dep-card" onClick={e => e.stopPropagation()}>
        <div class="dep-head">
          <BmpText font={TITLE_FONT} text="WEAPONS DEPOT" />
          <div class="dep-sub">
            <BmpText font={SUB_FONT} text="CLICK ICON FOR DESCRIPTIONS" spacing={-1} />
          </div>
        </div>

        <div class="dep-cols">
          <Header
            k="qty"
            label="Qty"
            cls="c-qty"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="name"
            label="Name"
            cls="c-name"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="type"
            label="Type"
            cls="c-type"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="power"
            label="Power"
            cls="c-num"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="cost"
            label="Cost"
            cls="c-num"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
        </div>

        <ClassicScrollbar class="dep-list" onMouseMove={e => setPos({x: e.clientX, y: e.clientY})}>
          {rows.map(w => {
            const q = owned[w.index] ?? 0;
            const isSel = w.index === sel;
            const affordable = q === UNLIMITED || creds >= w.cost;
            // Table cells use the outlined font at native colour — its baked
            // white+black outline stays legible on every row state (green afford,
            // red broke, grey selected), so no per-state tint is applied.
            return (
              <div
                key={w.index}
                class={`dep-row${isSel ? ' sel' : ''}${affordable ? ' afford' : ' broke'}`}
                onClick={() => selectRow(w.index)}
                onMouseEnter={() => setHover(w.index)}
                onMouseLeave={() => setHover(h => (h === w.index ? null : h))}
              >
                <span class="c-qty">
                  {q === UNLIMITED ? (
                    <span class="dep-inf">∞</span>
                  ) : (
                    <BmpText font={TABLE_FONT} text={String(q)} spacing={-1} />
                  )}
                </span>
                <span class="c-name">
                  <WeaponIcon name={w.name} size={16} cls="dep-icon" />
                  <BmpText font={TABLE_FONT} text={w.name} spacing={-1} />
                </span>
                <span class="c-type">
                  <BmpText font={TABLE_FONT} text={String(w.type)} spacing={-1} />
                </span>
                <span class="c-num">
                  <BmpText font={TABLE_FONT} text={String(powerOf(w))} spacing={-1} />
                </span>
                <span class="c-num">
                  <BmpText font={TABLE_FONT} text={String(w.cost)} spacing={-1} />
                </span>
              </div>
            );
          })}
        </ClassicScrollbar>

        {hover !== null && WEAPON_DATABASE[hover] && (
          <WeaponTip w={WEAPON_DATABASE[hover]} x={pos.x} y={pos.y} />
        )}
        {showStats && selW && (
          <div class="dep-stats" onClick={() => setShowStats(false)}>
            <BmpText font={BIG_FONT} text={selW.name} />
            <div class="dep-stat-grid">
              {(
                [
                  ['Type', selW.type],
                  ['Damage', selW.damage],
                  ['Radius', selW.radius],
                  ['Dmg/area', weaponDamagePerArea(selW).toFixed(0)],
                  ['Variance', (selW.variance ?? 0).toFixed(1)],
                  ['Fodder', (selW.fodder ?? 0).toFixed(1)],
                  ['Cluster', selW.cluNum > 0 ? selW.cluNum : '-'],
                  ['Cost', `$${selW.cost}`],
                  ['Owned', owned[sel] === UNLIMITED ? '∞' : String(owned[sel] ?? 0)],
                ] as const
              ).map(([k, v]) => (
                <div class="dep-stat-row" key={k}>
                  <BmpText font={ROW_FONT} text={String(k)} />
                  <BmpText font={ROW_FONT} text={String(v)} />
                </div>
              ))}
            </div>
            <div class="dep-hint">
              <BmpText font={SMALL_FONT} text="click to close" />
            </div>
          </div>
        )}

        <div class="dep-foot">
          <div class="dep-money">
            <div class="dep-map">
              <BmpText font={STATUS_FONT} text={playerName.value} spacing={-1} />
            </div>
            <div class="dep-credits">
              <BmpText font={STATUS_FONT} text={`Credits ${creds}`} spacing={-1} />
            </div>
          </div>
          <div class="dep-btns">
            {/* Left cluster: Buy | Sell on top, Auto Buy spanning both beneath. */}
            <div class="dep-btn-col left">
              <DepBtn label="Buy" disabled={!canBuy} onClick={() => depotBuy(sel)} />
              <DepBtn label="Sell" disabled={!canSell} onClick={() => depotSell(sel)} />
              <DepBtn label="Auto Buy" span onClick={depotAutoBuy} />
            </div>
            {/* Right cluster: Stats over Close. */}
            <div class="dep-btn-col right">
              <DepBtn
                label="Stats"
                onClick={() => {
                  uiClick();
                  setShowStats(s => !s);
                }}
              />
              <DepBtn label="Close" onClick={closeDepot} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
