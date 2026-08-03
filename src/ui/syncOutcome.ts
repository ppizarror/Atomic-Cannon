/**
 * The vocabulary of "what did the last sync action do" — shared by the store that produces an
 * outcome (`syncStore`) and the i18n table that must have a line for every one of them.
 *
 * It lives in its own module, rather than in `syncStore` where it is used, precisely BECAUSE
 * `i18n/types.ts` keys its copy table off it: importing it from `syncStore` would drag that
 * store's `localStorage` / `document` dependencies into the i18n type graph — and from there
 * into the Cloudflare Worker's typecheck, which has no DOM. A type-only import is erased at
 * build time but is still followed by the compiler, so the fix has to be structural. Keep this
 * file free of runtime imports.
 */

/**
 * Machine-readable result of a sync action. The store never holds display copy: the Sync screen
 * maps these to localised strings, so a status line stays correct if the player changes language
 * while looking at it.
 */
export type SyncOutcome =
  // Successes.
  | 'created' // minted a new profile from this device
  | 'linked' // adopted an existing profile onto this device
  | 'uploaded' // pushed pending changes
  | 'downloaded' // pulled the cloud copy on demand
  | 'upToDate' // nothing to push
  // Failures.
  | 'conflict' // lost the compare-and-swap: another device wrote first
  | 'missing' // no profile under that id
  | 'tooLarge' // payload over the server's cap
  | 'rateLimited' // throttled by the Worker's per-IP limiter
  | 'offline' // couldn't reach the server at all
  | 'badData' // the stored blob isn't one of our backups
  | 'badCode'; // the typed id isn't a well-formed profile id
