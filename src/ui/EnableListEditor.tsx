/**
 * The "Define Weapons" / "Define Landscapes" enable-list editors (the Game Content
 * sub-screens). A paged, single-column toggle list over the brushed-steel
 * plate: each row shows an icon/thumbnail + label and a right-aligned Enabled/Disabled
 * state; disabled rows are tinted red. Click a row to toggle it. Prev / Next page the
 * list; Exit returns to the Game Content page. The selection persists (contentStore)
 * and applies to the NEXT game, so editing never disturbs the running match.
 */
import type {ComponentChildren} from 'preact';
import {useLayoutEffect, useRef, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {Button} from './Button';
import {openSettingsPage, uiClick} from './store';
import {WeaponIcon} from './WeaponIcon';
import {EditorScreen} from './EditorScreen';
import {WEAPON_DATABASE, weaponName, weaponTypeName} from '../core/CWeapon';
import landData from '../data/land.json';
import {
  isWeaponOff,
  toggleWeapon,
  isLandOff,
  toggleLand,
  weaponsOff,
  landsOff,
} from './contentStore';
import {strings, fmt} from '../i18n';

const LANDS = landData as {bg: string}[];

function EditorRow({
  off,
  onToggle,
  children,
}: {
  off: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}) {
  return (
    <button class={`editor-row ${off ? 'off' : 'on'}`} onClick={onToggle}>
      <span class="editor-body">{children}</span>
      <span class="editor-state">
        <BmpText
          font="beijing-16-out"
          text={
            off
              ? strings.value.editors.enableList.disabled
              : strings.value.editors.enableList.enabled
          }
        />
      </span>
    </button>
  );
}

// First-render guess (refined by measuring the panel) so the initial page isn't empty.
const estimatePerPage = (rowHeight: number): number =>
  typeof window !== 'undefined'
    ? Math.max(3, Math.floor((window.innerHeight * 0.6) / rowHeight))
    : 12;

function Editor({
  title,
  footer,
  count,
  rowHeight,
  layout,
  row,
}: {
  title: string;
  footer: string;
  count: number;
  rowHeight: number;
  layout: 'weapons' | 'lands';
  row: (i: number) => {off: boolean; toggle: () => void; body: ComponentChildren};
}) {
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(() => estimatePerPage(rowHeight));
  const listRef = useRef<HTMLDivElement>(null);

  // Fit as many rows as the panel is tall; recompute on any resize (window / fullscreen).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const rowH = (el.firstElementChild as HTMLElement | null)?.offsetHeight || rowHeight;
      const n = Math.max(3, Math.floor(el.clientHeight / (rowH + 1))); // +1 for the row gap
      setPerPage(prev => (prev === n ? prev : n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowHeight]);

  const pages = Math.max(1, Math.ceil(count / perPage));
  const p = Math.min(page, pages - 1);
  const start = p * perPage;

  const e = strings.value.editors.enableList;
  const items = [];
  for (let i = start; i < Math.min(start + perPage, count); i++) {
    const r = row(i);
    items.push(
      <EditorRow key={i} off={r.off} onToggle={r.toggle}>
        {r.body}
      </EditorRow>,
    );
  }

  return (
    <EditorScreen
      title={title}
      footer={
        <>
          <BmpText font="beijing-16-out" text={footer} />
          <BmpText font="beijing-16-out" text={fmt(e.pagination, {page: p + 1, pages})} />
        </>
      }
      actions={
        <>
          <Button label={e.prev} onClick={() => (uiClick(), setPage(Math.max(0, p - 1)))} />
          <Button label={e.next} onClick={() => (uiClick(), setPage(Math.min(pages - 1, p + 1)))} />
          <Button label={e.exit} onClick={() => openSettingsPage('content')} class="editor-exit" />
        </>
      }
    >
      <div ref={listRef} class={`editor-list editor-${layout}`}>
        {items}
      </div>
    </EditorScreen>
  );
}

export function WeaponsEditor() {
  void weaponsOff.value; // subscribe so toggles re-render
  return (
    <Editor
      title={strings.value.editors.enableList.weaponsTitle}
      footer={strings.value.editors.enableList.weaponsFooter}
      count={WEAPON_DATABASE.length}
      rowHeight={25}
      layout="weapons"
      row={i => {
        const w = WEAPON_DATABASE[i];
        return {
          off: isWeaponOff(i),
          toggle: () => (toggleWeapon(i), uiClick()),
          body: (
            <>
              <WeaponIcon name={w.icon} size={16} cls="wicon" />
              <BmpText
                font="beijing-16-out"
                text={`${weaponName(w)} (${weaponTypeName(w.type)})`}
              />
            </>
          ),
        };
      }}
    />
  );
}

export function LandscapesEditor() {
  void landsOff.value; // subscribe so toggles re-render
  return (
    <Editor
      title={strings.value.editors.enableList.landscapesTitle}
      footer={strings.value.editors.enableList.landscapesFooter}
      count={LANDS.length}
      rowHeight={56}
      layout="lands"
      row={i => ({
        off: isLandOff(i),
        toggle: () => (toggleLand(i), uiClick()),
        body: (
          <>
            <img class="editor-thumb" src={`/assets/${LANDS[i].bg}`} alt="" />
            <BmpText font="beijing-16-out" text={`${i + 1}`} />
          </>
        ),
      })}
    />
  );
}
