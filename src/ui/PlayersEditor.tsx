/**
 * "Customize Players" — the per-player card editor. Paged one player at a time
 * (`< / >`), each with an editable name, a colour picked from the rainbow
 * `color pallette.bmp` (with a live swatch), and a tank model cycled through the
 * available hulls (with a recoloured preview). Colour is the player's team identity —
 * players who pick the same colour are teammates. Edits persist (playersStore) and
 * apply at the next game; `Done` returns to the Settings root.
 *
 * Name entry uses a plain text field rather than the original's on-screen bitmap
 * keyboard — the keyboard is pure input plumbing with no gameplay effect.
 */
import {useEffect, useRef, useState} from 'preact/hooks';
import {BmpText} from './BmpText';
import {Button} from './Button';
import {openSettingsPage, uiClick} from './store';
import {roster, setName, setColor, cycleModel, MAX_PLAYERS} from './playersStore';
import {loadPalette, samplePalette, findNearestInPalette, recolorTankPreview} from './palette';

function TankPreview({model, color}: {model: string; color: string}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let ok = true;
    recolorTankPreview(model, color)
      .then(s => ok && setSrc(s))
      .catch(() => ok && setSrc(''));
    return () => {
      ok = false;
    };
  }, [model, color]);
  return <span class="player-preview">{src ? <img src={src} alt="" /> : null}</span>;
}

function ColorPicker({value, onPick}: {value: string; onPick: (hex: string) => void}) {
  const [data, setData] = useState<ImageData | null>(null);
  const [mark, setMark] = useState<{fx: number; fy: number} | null>(null);

  useEffect(() => {
    let ok = true;
    loadPalette().then(d => ok && setData(d));
    return () => {
      ok = false;
    };
  }, []);

  // Place the crosshair on the palette pixel nearest the current colour (works for
  // stored/default colours too, not just fresh clicks).
  useEffect(() => {
    if (data) setMark(findNearestInPalette(data, value));
  }, [data, value]);

  const imgRef = useRef<HTMLImageElement>(null);
  const dragging = useRef(false);

  // Sample the palette at the pointer (clamped to the bar) and commit the colour.
  const pickAt = (clientX: number, clientY: number) => {
    if (!data || !imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    onPick(samplePalette(data, fx, fy));
  };

  const onDown = (e: PointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pickAt(e.clientX, e.clientY);
    uiClick();
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (dragging.current) pickAt(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent) => {
    dragging.current = false;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  return (
    <div class="player-color">
      <BmpText font="beijing-16-out" text="Color:" />
      <span class="player-swatch" style={{background: value}} />
      <span class="player-palette-wrap">
        <img
          ref={imgRef}
          class="player-palette"
          src="/assets/gui/color pallette.bmp"
          alt="colour palette"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {mark ? (
          <span
            class="palette-crosshair"
            // Left tracks the (variable-width) bar as a %, but top is pinned in px
            // against the fixed 40px bar height and clamped so the ring never clips —
            // the pure hues sit on the top row (fy≈0).
            style={{left: `${mark.fx * 100}%`, top: `${Math.min(34, Math.max(6, mark.fy * 40))}px`}}
          />
        ) : null}
      </span>
    </div>
  );
}

export function PlayersEditor() {
  const list = roster.value; // subscribe so the card re-renders on edit
  const [p, setP] = useState(0);
  const count = Math.min(MAX_PLAYERS, list.length);
  const idx = Math.min(p, count - 1);
  const cfg = list[idx];

  const page = (d: number) => {
    uiClick();
    setP((idx + d + count) % count); // wrap like the original's < / >
  };

  return (
    <div class="editor-screen">
      <div class="editor-title">
        <BmpText font="bazouk-28" text="Player Settings" />
      </div>

      <div class="player-card">
        <div class="player-head">
          <Button label="<" onClick={() => page(-1)} class="player-page" />
          <Button label=">" onClick={() => page(1)} class="player-page" />
          <BmpText font="beijing-16-out" text={`Player ${idx + 1} Name:`} />
          <input
            class="player-name"
            type="text"
            maxLength={16}
            value={cfg.name}
            onInput={e => setName(idx, (e.currentTarget as HTMLInputElement).value)}
          />
        </div>

        <ColorPicker value={cfg.color} onPick={hex => setColor(idx, hex)} />

        <div class="player-tank">
          <TankPreview model={cfg.model} color={cfg.color} />
          <div class="player-model">
            <Button
              label="<"
              onClick={() => (uiClick(), cycleModel(idx, -1))}
              class="player-page"
            />
            <span class="player-model-name">
              <BmpText font="beijing-16-out" text={cfg.model} />
            </span>
            <Button label=">" onClick={() => (uiClick(), cycleModel(idx, 1))} class="player-page" />
          </div>
        </div>
      </div>

      <div class="editor-footer">
        <BmpText font="beijing-16-out" text="Players sharing a colour are a team" />
      </div>

      <div class="editor-buttons">
        <Button label="Done" onClick={() => openSettingsPage('root')} />
      </div>
    </div>
  );
}
