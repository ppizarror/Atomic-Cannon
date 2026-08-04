/**
 * "Customize Players" — the per-player card editor. Paged one slot at a time (`< / >`)
 * through two pools: the human players (slots 1..8), then the bots (slots 1..8) — the
 * same split the match reads (setupTanks), so a "Bot N" card configures the CPU you
 * actually face. Each card has an editable name, a colour picked from the rainbow
 * `color pallette.bmp` (with a live swatch), and a tank model cycled through the
 * available hulls (with a recoloured preview). Colour is the player's team identity —
 * players who pick the same colour are teammates. Edits persist (playersStore) and
 * apply at the next game; `Done` returns to the Settings root.
 *
 * Name entry uses a plain text field rather than the original's on-screen bitmap
 * keyboard — the keyboard is pure input plumbing with no gameplay effect.
 */
import {useEffect, useRef, useState} from 'preact/hooks';
import type {RefObject} from 'preact';
import {BmpText} from './BmpText';
import {Button} from './Button';
import {EditorDone} from './EditorDone';
import {uiClick, uiTyping} from './store';
import {roster, setName, setColor, cycleModel, MAX_PLAYERS} from './playersStore';
import {MAX_HUMANS} from './setupStore';
import {loadPalette, samplePalette, findNearestInPalette, runTankPreview, type TankPreviewHandle} from './palette';
import {usePointerDrag} from './usePointerDrag';
import {EditorScreen} from './EditorScreen';
import {useAsyncValue} from './useAsyncValue';
import {strings, fmt} from '../i18n';
import {clamp01} from '../math/num';

/**
 * The live hull preview — a canvas whose barrel tracks the pointer while it is over the card
 * (`aimWithin`), and holds its last aim once you leave. See `runTankPreview`.
 */
function TankPreview({model, color, aimWithin}: {model: string; color: string; aimWithin: RefObject<HTMLDivElement>}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const preview = useRef<TankPreviewHandle | null>(null);

  // Started once and kept across hull/colour changes: the aim lives inside the preview, so paging
  // to another tank re-draws it at the angle you left the barrel at instead of snapping to rest.
  useEffect(() => {
    const cv = ref.current,
      card = aimWithin.current;
    if (!cv || !card) return;
    const p = runTankPreview(cv, card);
    preview.current = p;
    return () => {
      p.dispose();
      preview.current = null;
    };
  }, [aimWithin]);

  useEffect(() => {
    preview.current?.show(model, color);
  }, [model, color]);

  return (
    <span class="player-preview">
      <canvas ref={ref} />
    </span>
  );
}

function ColorPicker({value, onPick}: {value: string; onPick: (hex: string) => void}) {
  const data = useAsyncValue<ImageData | null>(loadPalette, [], null);
  const [mark, setMark] = useState<{fx: number; fy: number} | null>(null);

  // Place the crosshair on the palette pixel nearest the current colour (works for
  // stored/default colours too, not just fresh clicks).
  useEffect(() => {
    if (data) setMark(findNearestInPalette(data, value));
  }, [data, value]);

  const imgRef = useRef<HTMLImageElement>(null);

  // Sample the palette at the pointer (clamped to the bar) and commit the colour.
  const pickAt = (clientX: number, clientY: number) => {
    if (!data || !imgRef.current) return;
    const r = imgRef.current.getBoundingClientRect();
    const fx = clamp01((clientX - r.left) / r.width);
    const fy = clamp01((clientY - r.top) / r.height);
    onPick(samplePalette(data, fx, fy));
  };

  const drag = usePointerDrag<HTMLImageElement>({
    onStart: e => {
      pickAt(e.clientX, e.clientY);
      uiClick();
    },
    onMove: e => pickAt(e.clientX, e.clientY),
  });

  const e = strings.value.editors.players;
  return (
    <div class="player-color">
      <BmpText font="beijing-16-out" text={e.color} />
      <span class="player-swatch" style={{background: value}} />
      <span class="player-palette-wrap">
        <img ref={imgRef} class="player-palette" src="/assets/gui/color pallette.bmp" alt={e.palette} {...drag} />
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
  // Page through ALL roster slots, split into two pools: slots 0..MAX_HUMANS-1 are the HUMAN
  // players, the rest are the BOTS (the same layout the match reads — see setupTanks). So you
  // page Player 1..8, then Bot 1..8, and can pre-configure every slot regardless of match size.
  const count = Math.max(1, Math.min(MAX_PLAYERS, list.length));
  const idx = Math.min(p, count - 1);
  const cfg = list[idx];
  const isHuman = idx < MAX_HUMANS; // first pool = human players; second pool = bots
  const slotN = isHuman ? idx + 1 : idx - MAX_HUMANS + 1; // number within its own pool
  const e = strings.value.editors.players;

  const page = (d: number) => {
    uiClick();
    setP((idx + d + count) % count); // wrap like the original's < / >
  };

  // The preview's turret aims at the pointer only while it's over this card, so the tank tracks
  // you around its own panel and ignores movement elsewhere on the screen.
  const cardRef = useRef<HTMLDivElement>(null);

  return (
    <EditorScreen
      title={e.title}
      footer={<BmpText font="beijing-16-out" text={e.footer} />}
      actions={<EditorDone label={e.done} class="" />}
    >
      <div class="player-card" ref={cardRef}>
        <div class="player-head">
          <Button label="<" onClick={() => page(-1)} class="player-page" />
          <Button label=">" onClick={() => page(1)} class="player-page" />
          <BmpText font="beijing-16-out" text={fmt(isHuman ? e.playerName : e.botName, {n: slotN})} />
          <span class={`player-kind ${isHuman ? 'is-human' : 'is-cpu'}`}>
            <BmpText font="beijing-16-out" text={isHuman ? e.human : e.computer} spacing={-1} />
          </span>
          <input
            class="player-name"
            type="text"
            maxLength={16}
            value={cfg.name}
            onInput={e => setName(idx, (e.currentTarget as HTMLInputElement).value)}
            // typing.wav per keystroke, matching the original's on-screen keyboard.
            onKeyDown={e => {
              if (e.key.length === 1 || e.key === 'Backspace') uiTyping();
            }}
          />
        </div>

        <ColorPicker value={cfg.color} onPick={hex => setColor(idx, hex)} />

        <div class="player-tank">
          <TankPreview model={cfg.model} color={cfg.color} aimWithin={cardRef} />
          <div class="player-model">
            <Button label="<" onClick={() => (uiClick(), cycleModel(idx, -1))} class="player-page" />
            <span class="player-model-name">
              <BmpText font="beijing-16-out" text={cfg.model} />
            </span>
            <Button label=">" onClick={() => (uiClick(), cycleModel(idx, 1))} class="player-page" />
          </div>
        </div>
      </div>
    </EditorScreen>
  );
}
