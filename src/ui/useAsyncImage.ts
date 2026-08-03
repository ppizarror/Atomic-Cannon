/**
 * One ok-flag guard for every leaf that loads an image (weapon icons, the depot sort arrow, the
 * atom logo, the title reticle tile), rather than the same guard hand-rolled in each of them.
 */

import {useState, useEffect} from 'preact/hooks';

/**
 * Subscribe to an async image loader (resolves to a data URL, or null on failure).
 * Returns the resolved src, or '' until it loads. Re-runs when `deps` change and
 * ignores a result that arrives after unmount / a dep change.
 */
export function useAsyncImage(load: () => Promise<string | null>, deps: unknown[]): string {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let ok = true;
    // Some loaders (e.g. the tank-preview recolor) REJECT on a missing/corrupt image rather than
    // resolving null — swallow it so a bad asset is a blank preview, not an uncaught rejection.
    load()
      .then(u => {
        if (ok && u) setSrc(u);
      })
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, deps);
  return src;
}
