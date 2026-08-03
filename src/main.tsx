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

async function main(): Promise<void> {
  // Never fatal: bootSync swallows its own failures and is bounded by its own timeout, but a
  // catch here guarantees that nothing about sync can stop the game from starting.
  try {
    await bootSync();
  } catch {
    /* offline, throttled, storage unavailable — play on this device's data */
  }
  const {startApp} = await import('./app');
  await startApp();
}

void main();
