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
import {loadPalette, samplePalette, recolorTank} from './palette';

function TankPreview({model, color}: {model: string; color: string}) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let ok = true;
    recolorTank(`/assets/tanks/${model} body.bmp`, color)
      .then(s => ok && setSrc(s))
      .catch(() => ok && setSrc(''));
    return () => {
      ok = false;
    };
  }, [model, color]);
  return <span class="player-preview">{src ? <img src={src} alt="" /> : null}</span>;
}

function ColorPicker({value, onPick}: {value: string; onPick: (hex: string) => void}) {
  const dataRef = useRef<ImageData | null>(null);
  useEffect(() => {
    let ok = true;
    loadPalette().then(d => {
      if (ok) dataRef.current = d;
    });
    return () => {
      ok = false;
    };
  }, []);

  const pick = (e: MouseEvent) => {
    const data = dataRef.current;
    if (!data) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    onPick(samplePalette(data, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
    uiClick();
  };

  return (
    <div class="player-color">
      <BmpText font="msans-14" text="Color:" tint="#eef2f6" />
      <span class="player-swatch" style={{background: value}} />
      <img
        class="player-palette"
        src="/assets/gui/color pallette.bmp"
        alt="colour palette"
        onClick={pick}
      />
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
          <BmpText font="msans-14" text={`Player ${idx + 1} Name:`} tint="#eef2f6" />
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
          <Button label={`< ${cfg.model} >`} onClick={() => (uiClick(), cycleModel(idx, 1))} />
        </div>
      </div>

      <div class="editor-footer">
        <BmpText font="msans-14" text="Players sharing a colour are a team" tint="#c9d2da" />
      </div>

      <div class="editor-buttons">
        <Button label="Done" onClick={() => openSettingsPage('root')} />
      </div>
    </div>
  );
}
