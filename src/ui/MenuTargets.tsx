/**
 * The title screen's scrolling target reticles — rows of `target player.bmp`
 * (corner-bracket targets) that scroll horizontally, adjacent rows in OPPOSITE
 * directions, over the lower half of the main menu. A global scroll offset advances
 * each frame; the exact speed/spacing are tuned by eye.
 *
 * The reticle sprite is grey-on-black; we rebuild it as white brackets (alpha =
 * luminance) padded with a gap into a repeating tile, so a plain repeat-x + a CSS
 * position animation gives the scrolling effect (no per-frame JS).
 */
import {useAsyncImage} from './useAsyncImage';

const SPRITE = 40; // reticle size (px)
const TILE_W = 84; // sprite + gap → spacing between reticles
const ROWS = 2; // two rows (scrolling opposite ways)

// Build the repeating tile: white reticle (from the grey sprite's luminance) at the
// left of a TILE_W-wide transparent strip. Returns a data URL, or '' on failure.
function buildTile(): Promise<string> {
  return new Promise(resolve => {
    if (typeof document === 'undefined') {
      resolve('');
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const s = document.createElement('canvas');
        s.width = SPRITE;
        s.height = SPRITE;
        const sg = s.getContext('2d');
        if (!sg) {
          resolve('');
          return;
        }
        sg.drawImage(img, 0, 0, SPRITE, SPRITE);
        const im = sg.getImageData(0, 0, SPRITE, SPRITE);
        const p = im.data;
        for (let i = 0; i < p.length; i += 4) {
          const lum = Math.max(p[i], p[i + 1], p[i + 2]); // grey brackets on black
          p[i] = p[i + 1] = p[i + 2] = 255; // → white
          p[i + 3] = lum; // alpha from brightness
        }
        sg.putImageData(im, 0, 0);
        const tile = document.createElement('canvas');
        tile.width = TILE_W;
        tile.height = SPRITE;
        tile.getContext('2d')?.drawImage(s, 0, 0);
        resolve(tile.toDataURL());
      } catch {
        resolve('');
      }
    };
    img.onerror = () => resolve('');
    img.src = '/assets/gui/target player.bmp';
  });
}

export function MenuTargets() {
  const tile = useAsyncImage(buildTile, []);
  if (!tile) return null;

  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push(<div key={i} class={`tgt-row ${i % 2 ? 'tgt-r' : 'tgt-l'}`} style={{backgroundImage: `url(${tile})`}} />);
  }
  return <div class="tgt-rows">{rows}</div>;
}
