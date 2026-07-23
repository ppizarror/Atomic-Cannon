/**
 * Returns a stable `bump()` that forces the component to re-render — for state that lives
 * OUTSIDE preact (subsystems whose widgets read/write them directly, e.g. CAudio volumes or
 * the live fullscreen state) where nothing signals a change on its own.
 */
import {useCallback, useState} from 'preact/hooks';

export function useForceRender(): () => void {
  const [, setTick] = useState(0);
  return useCallback(() => setTick(v => v + 1), []);
}
