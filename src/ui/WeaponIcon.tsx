/**
 * A weapon's arsenal icon — the magenta-keyed `.bmp` decoded to a data URL (via
 * `loadWeaponIcon`), or a same-size placeholder until it loads so nothing reflows. `cls`
 * carries the display size + `image-rendering: pixelated`. Shared by the HUD weapon list,
 * the depot rows, and the Game-Content enable-list editor (each was its own copy).
 */
import {useAsyncImage} from './useAsyncImage';
import {loadWeaponIcon} from './store';

export function WeaponIcon({name, size, cls}: {name: string; size: 12 | 16 | 32; cls: string}) {
  const src = useAsyncImage(() => loadWeaponIcon(name, size), [name, size]);
  return src ? <img class={cls} src={src} alt="" /> : <span class={cls} />;
}
