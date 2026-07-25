/**
 * Weapons Depot — the buy/sell screen. Shown above the battle HUD (via the
 * `showDepot` signal): a brushed-metal panel, the
 * game's own bitmap fonts, a sortable Qty / Name / Type / Power / Cost table with
 * green affordability rows, a green tooltip (the `zeon` UI kit) describing the
 * weapon under the cursor, and Buy / Sell / Auto Buy / Stats / Close controls
 * (the metal button art) over a Credits readout.
 */
import {useMemo, useState, useEffect, useRef} from 'preact/hooks';
import {BmpText} from './BmpText';
import {Tooltip} from './Tooltip';
import {ClassicScrollbar} from './ClassicScrollbar';
import {GameConfig} from '../core/CGameConfig';
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
  weaponName,
  weaponDesc,
  weaponTypeName,
  type WeaponDef,
} from '../core/CWeapon';
import {strings} from '../i18n';
import {weaponEnabled} from '../core/CGameContent';
import {UNLIMITED} from '../core/CEconomy';

type SortKey = 'qty' | 'name' | 'type' | 'power' | 'cost';

// Every panel (header, stats popup, footer) uses the game's OUTLINED bitmap faces
// (white glyph + baked black outline) so text stays legible on the metal — fonts are
// chosen inline at each call site. The table is the one exception: it drops to the
// compact 8px pixel font under Graphics → Small Buy Fonts so more of the arsenal fits.
const tableFont = () => (GameConfig.smallBuyFonts ? 'silkscreen-8-out' : 'beijing-16-out');

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
      <BmpText font={tableFont()} text={label} spacing={-1} />
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
        title={weaponName(w)}
        content={weaponDesc(w) || strings.value.depot.noDescription}
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
  // On OPEN, scroll the list so the currently-selected weapon is visible (centered) rather than
  // always starting at the top — the depot opens on whatever weapon you had equipped. Mount-only.
  const selRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selRowRef.current?.scrollIntoView({block: 'center'});
  }, []);
  const [sort, setSort] = useState<{key: SortKey; dir: 1 | -1}>({key: 'cost', dir: 1});
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState({x: 0, y: 0});
  const [showStats, setShowStats] = useState(false);

  const owned = ownedCounts.value;
  const creds = credits.value;
  const d = strings.value.depot;

  // The catalog, sorted by the active column. Rebuilt only when sort/owned change.
  const rows = useMemo(() => {
    const val = (w: WeaponDef): number | string => {
      switch (sort.key) {
        case 'qty':
          return owned[w.index] ?? 0;
        case 'name':
          return weaponName(w).toLowerCase();
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
  };

  // Equip the chosen weapon when the user closes the depot: without this you could buy a weapon, pick
  // it, close, and still be holding your OLD weapon (the select-time equip was silently swallowed by
  // the pause). Only the user-driven closes equip — the turn-change auto-close (syncHud) calls
  // closeDepot directly, so a forfeit can't equip this tank's pick onto the next player's tank.
  const closeAndEquip = () => {
    closeDepot();
    // Equip the picked row only if it's actually usable — the unlimited staple or something you own.
    // Browsing an un-owned weapon (to read its stats) must NOT switch you to a weapon you can't fire.
    if (owned[sel] === UNLIMITED || (owned[sel] ?? 0) > 0) game().selectWeapon(sel);
  };

  const selW = WEAPON_DATABASE[sel];
  const canBuy = !!selW && owned[sel] !== UNLIMITED && creds >= selW.cost;
  const canSell = !!selW && owned[sel] !== UNLIMITED && (owned[sel] ?? 0) > 0;

  return (
    <div class="overlay dep-overlay" onClick={closeAndEquip}>
      <div
        class={`dep-card${GameConfig.smallBuyFonts ? ' small-buy' : ''}`}
        onClick={e => e.stopPropagation()}
      >
        <div class="dep-head">
          <BmpText font="bazouk-28" text={d.title} />
          <div class="dep-sub">
            <BmpText font="arial-14-out" text={d.subtitle} spacing={-1} />
          </div>
        </div>

        <div class="dep-cols">
          <Header
            k="qty"
            label={d.col.qty}
            cls="c-qty"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="name"
            label={d.col.name}
            cls="c-name"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="type"
            label={d.col.type}
            cls="c-type"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="power"
            label={d.col.power}
            cls="c-num"
            activeKey={sort.key}
            dir={sort.dir}
            onSort={clickHeader}
          />
          <Header
            k="cost"
            label={d.col.cost}
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
                ref={isSel ? selRowRef : undefined}
                class={`dep-row${isSel ? ' sel' : ''}${affordable ? ' afford' : ' broke'}`}
                onClick={() => selectRow(w.index)}
                onMouseEnter={() => setHover(w.index)}
                onMouseLeave={() => setHover(h => (h === w.index ? null : h))}
              >
                <span class="c-qty">
                  {q === UNLIMITED ? (
                    <span class="dep-inf">∞</span>
                  ) : (
                    <BmpText font={tableFont()} text={String(q)} spacing={-1} />
                  )}
                </span>
                <span class="c-name">
                  <WeaponIcon name={w.icon} size={16} cls="dep-icon" />
                  <BmpText font={tableFont()} text={weaponName(w)} spacing={-1} />
                </span>
                <span class="c-type">
                  <BmpText font={tableFont()} text={weaponTypeName(w.type)} spacing={-1} />
                </span>
                <span class="c-num">
                  <BmpText font={tableFont()} text={String(powerOf(w))} spacing={-1} />
                </span>
                <span class="c-num">
                  <BmpText font={tableFont()} text={String(w.cost)} spacing={-1} />
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
            <BmpText font="bazouk-28" text={weaponName(selW)} />
            <div class="dep-stat-grid">
              {(
                [
                  [d.stat.type, weaponTypeName(selW.type)],
                  [d.stat.damage, selW.damage],
                  [d.stat.radius, selW.radius],
                  [d.stat.dmgArea, weaponDamagePerArea(selW).toFixed(0)],
                  [d.stat.variance, (selW.variance ?? 0).toFixed(1)],
                  [d.stat.fodder, (selW.fodder ?? 0).toFixed(1)],
                  [d.stat.cluster, selW.cluNum > 0 ? selW.cluNum : '-'],
                  [d.stat.cost, `$${selW.cost}`],
                  [d.stat.owned, owned[sel] === UNLIMITED ? '∞' : String(owned[sel] ?? 0)],
                ] as const
              ).map(([k, v]) => (
                <div class="dep-stat-row" key={k}>
                  <BmpText font="beijing-16-out" text={String(k)} spacing={-1} />
                  <BmpText font="beijing-16-out" text={String(v)} spacing={-1} />
                </div>
              ))}
            </div>
            <div class="dep-hint">
              <BmpText font="arial-14-out" text={d.clickToClose} spacing={-1} />
            </div>
          </div>
        )}

        <div class="dep-foot">
          <div class="dep-money">
            <div class="dep-map">
              <BmpText font="beijing-16-out" text={playerName.value} spacing={-1} />
            </div>
            <div class="dep-credits">
              <BmpText font="beijing-16-out" text={`${d.credits} ${creds}`} spacing={-1} />
            </div>
          </div>
          <div class="dep-btns">
            {/* Left cluster: Buy | Sell on top, Auto Buy spanning both beneath. */}
            <div class="dep-btn-col left">
              <DepBtn label={d.buy} disabled={!canBuy} onClick={() => depotBuy(sel)} />
              <DepBtn label={d.sell} disabled={!canSell} onClick={() => depotSell(sel)} />
              <DepBtn label={d.autoBuy} span onClick={depotAutoBuy} />
            </div>
            {/* Right cluster: Stats over Close. */}
            <div class="dep-btn-col right">
              <DepBtn
                label={d.stats}
                onClick={() => {
                  uiClick();
                  setShowStats(s => !s);
                }}
              />
              <DepBtn label={d.close} onClick={closeAndEquip} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
