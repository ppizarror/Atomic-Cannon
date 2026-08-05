/**
 * Atomic Cannon - entry point.
 *
 * Deliberately tiny, and deliberately the ONLY module loaded eagerly. Its whole job is to give
 * profile sync a chance to pull a newer cloud save into localStorage *before* the app is
 * imported: every persisted store seeds its signal from storage the moment its module is
 * evaluated, so a pull that lands afterwards would need a `location.reload()` to take effect —
 * a visible flash on every launch where another device was ahead. Importing `./app` dynamically
 * is what buys that window.
 *
 * The stylesheet stays eager (it has no storage side effects) so the page is never painted
 * unstyled while the pull is in flight.
 */
import './hud.css';
import {bootSync} from './ui/syncStore';

/**
 * Whether the boot pull runs. Under `pnpm dev` the Vite server proxies `/api` to wrangler on
 * :8787, which is frequently not there — not running at all, or (worse, because it still holds
 * the port and accepts the connection) a `wrangler dev` left over from a previous session that
 * has stopped answering. Either way the pull cannot succeed, and because it blocks the app import
 * by design, every single reload pays the full `PROFILE_BOOT_TIMEOUT_MS` before the game starts.
 * Measured at 2.8s vs 0.3s on the edit/reload loop.
 *
 * Add `?sync` to opt back in when there IS a live worker to talk to. A production bundle has
 * `import.meta.env.DEV` statically false, so this collapses to `true` and tree-shakes away.
 */
const syncOnBoot = (): boolean => !import.meta.env.DEV || new URLSearchParams(location.search).has('sync');

async function main(): Promise<void> {
  // Never fatal: bootSync swallows its own failures and is bounded by its own timeout, but a
  // catch here guarantees that nothing about sync can stop the game from starting.
  try {
    if (syncOnBoot()) await bootSync();
  } catch {
    /* offline, throttled, storage unavailable — play on this device's data */
  }
  const {startApp} = await import('./app');
  await startApp();
}

void main();
