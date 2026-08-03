/**
 * One ok-flag guard for every leaf that loads an image (weapon icons, the depot sort arrow, the
 * atom logo, the title reticle tile), rather than the same guard hand-rolled in each of them.
 */

import {useAsyncValue} from './useAsyncValue';

/**
 * Subscribe to an async image loader (resolves to a data URL, or null on failure).
 * Returns the resolved src, or '' until it loads. Re-runs when `deps` change and
 * ignores a result that arrives after unmount / a dep change.
 */
export function useAsyncImage(load: () => Promise<string | null>, deps: unknown[]): string {
  return useAsyncValue(() => load().then(u => u ?? ''), deps, '');
}
