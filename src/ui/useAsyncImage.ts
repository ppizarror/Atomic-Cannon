import { useState, useEffect } from 'preact/hooks';

/**
 * Subscribe to an async image loader (resolves to a data URL, or null on failure).
 * Returns the resolved src, or '' until it loads. Re-runs when `deps` change and
 * ignores a result that arrives after unmount / a dep change — the ok-flag guard
 * that was hand-rolled identically in five leaf components (weapon icons, the depot
 * sort arrow, the atom logo, the title reticle tile).
 */
export function useAsyncImage(load: () => Promise<string | null>, deps: unknown[]): string {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let ok = true;
    load().then(u => { if (ok && u) setSrc(u); });
    return () => { ok = false; };
  }, deps);
  return src;
}
