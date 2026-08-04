/**
 * The client half of the global play counters: drains the controller's play tally as each battle
 * ends (and once more when the war does) and POSTs it to `/api/stats`.
 *
 * Two rules make the counters actually reflect play:
 *   • Nothing is click-gated. Gating the upload on the player clicking past the final war standings
 *     would discard the whole match whenever they quit to the menu — or just closed the tab on the
 *     victory screen. The engine banks each battle the moment it ends, and the UI flushes again
 *     when the player quits to the menu and when the page goes away.
 *   • A failed POST is never lost play: the delta is merged back into `pending` and rides along with
 *     the next flush (an offline stretch costs one request, not the stats).
 *
 * A single flight at a time keeps the ordering trivial and can't stampede the per-IP rate limit.
 */
import type {CGameController, StatsFlush} from '../game/CGameController';
import {emptyDelta, isEmptyDelta, mergeDelta, postStatsDelta, type StatsDelta} from '../net/stats';

let controller: CGameController | null = null;
/** Play drained from the engine but not yet accepted by the server. */
let pending: StatsDelta = emptyDelta();
let inflight = false;

/** Wire the uploader to the live controller and to the page-teardown events. Called once, from
 *  setController — the engine's own battle/war hook is wired there too. */
export function initStatsUpload(gc: CGameController): void {
  controller = gc;
  if (typeof window === 'undefined') return;
  // Last chance to bank the battle in progress: pagehide covers navigation/back-forward cache, and the
  // hidden visibility state covers a mobile tab being swiped away (which may never fire pagehide).
  // `postStatsDelta` uses keepalive, so the request survives the page going away.
  addEventListener('pagehide', () => void flushStats());
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushStats();
  });
}

/**
 * Drain the play accrued since the last flush and upload it, stamped with whatever progress
 * `closed` completes (nothing, for a quit / page-hide flush — that just banks the play).
 *
 * Always drains, even on a client that doesn't upload (a net peer / spectator), so the tally can't
 * pile up and land in a later delta if roles change mid-match.
 */
export async function flushStats(closed: StatsFlush = {}): Promise<void> {
  const gc = controller;
  if (!gc) return;
  const delta = gc.takeStatsDelta(closed);
  if (!gc.isStatsUploader()) return; // only one client per match reports it (solo always does)
  pending = mergeDelta(pending, delta);
  if (inflight || isEmptyDelta(pending)) return;

  const sending = pending;
  pending = emptyDelta();
  inflight = true;
  const ok = await postStatsDelta(sending);
  inflight = false;
  // Failed → put it back in front of anything that accumulated while the request was out.
  if (!ok) pending = mergeDelta(sending, pending);
}
