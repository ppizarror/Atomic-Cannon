/**
 * Shareable codes — the alphabet, generator and input-formatter behind every human-typed key
 * in the game: the 6-char ROOM code you send to friends, and the 12-char PROFILE id that names
 * a cloud settings/score save. In both cases the canonical code *is* a Durable Object name, so
 * the same string always routes to the same instance.
 *
 * Isomorphic: imported by both the browser client and the Worker/DO. No DOM, no Node, no
 * Workers API — a random source is injected so the same generator works with
 * `crypto.getRandomValues` (prod) or a seeded PRNG (tests).
 *
 * Length and grouping are parameters rather than constants because the two code kinds differ
 * only in those two numbers; `roomCode.ts` / `profileCode.ts` are thin named specialisations
 * so callers never pass a raw length around.
 */

/** Crockford-ish alphabet: no I/L/O/0/1, so codes are unambiguous when read aloud/typed. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A source of uniform integers in [0, n). */
export type RandInt = (n: number) => number;

/** crypto-backed RandInt (rejection-sampled to stay unbiased). Works in browsers and Workers. */
export const cryptoRandInt: RandInt = (n: number): number => {
  if (n <= 0) return 0;
  const limit = Math.floor(0x100000000 / n) * n; // largest multiple of n ≤ 2^32
  const buf = new Uint32Array(1);
  let x = 0;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % n;
};

/** Generate a fresh canonical code of `len` chars (no separator). */
export function newCode(len: number, randInt: RandInt = cryptoRandInt): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Fold user input to canonical form: uppercase, then keep only alphabet chars (so separators,
 * spaces, and the excluded look-alikes I/L/O/0/1 — which never appear in a real code — are
 * dropped). Returns up to `len` chars.
 */
export function normalizeCode(input: string, len: number): string {
  let out = '';
  for (const ch of input.toUpperCase()) if (CODE_ALPHABET.includes(ch)) out += ch;
  return out.slice(0, len);
}

/** True iff `code` is already a valid canonical code of exactly `len` chars. */
export function isValidCode(code: string, len: number): boolean {
  if (code.length !== len) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Human-friendly rendering, split by a single hyphen after `at` chars: "ABC-D23". A code that
 *  isn't full length is returned uppercased but ungrouped (it isn't a real code yet). */
export function groupCode(code: string, len: number, at: number): string {
  const c = code.toUpperCase();
  return c.length === len ? `${c.slice(0, at)}-${c.slice(at)}` : c;
}

/**
 * Format a code as it's typed into an input: uppercase, keep only code chars, and insert a
 * single hyphen after the `at`-th char (ABC → ABC-D23). A paste is passed through (just
 * uppercased/clipped) so it isn't reshaped — `normalizeCode` handles it on submit either way.
 */
export function formatTypedCode(raw: string, isPaste: boolean, len: number, at: number): string {
  if (isPaste) return raw.toUpperCase().slice(0, len + 1); // +1 for the separator
  const clean = normalizeCode(raw, len);
  return clean.length > at ? `${clean.slice(0, at)}-${clean.slice(at)}` : clean;
}
