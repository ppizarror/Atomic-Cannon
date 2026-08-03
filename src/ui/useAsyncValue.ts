/**
 * Generalises the ok-flag async-load guard for a value of any type (`useAsyncImage` is the
 * string/image special case).
 */

import {useEffect, useState} from 'preact/hooks';

/**
 * Runs `load` on mount and whenever `deps` change, ignores a result that arrives after
 * unmount / a dep change, and swallows rejections — returning `initial` until (and unless)
 * the load resolves.
 */
export function useAsyncValue<T>(load: () => Promise<T>, deps: unknown[], initial: T): T {
  const [val, setVal] = useState<T>(initial);
  useEffect(() => {
    let ok = true;
    load()
      .then(v => ok && setVal(v))
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, deps);
  return val;
}
