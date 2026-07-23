/**
 * Room codes — the shareable "send this to your friends" join key. On
 * Cloudflare the canonical code *is* the Durable Object name, so every socket
 * for a code routes to the same room instance.
 *
 * Isomorphic: imported by both the browser client and the Worker/DO. No DOM,
 * no Node, no Workers API — a random source is injected so the same generator
 * works with `crypto.getRandomValues` (prod) or a seeded PRNG (tests).
 */

/** Crockford-ish alphabet: no I/L/O/0/1, so codes are unambiguous when read aloud/typed. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

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

/** Generate a fresh canonical room code (6 chars, no separator). */
export function newRoomCode(randInt: RandInt = cryptoRandInt): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[randInt(ALPHABET.length)];
  return out;
}

/**
 * Fold user input to canonical form: uppercase, then keep only alphabet chars
 * (so separators, spaces, and the excluded look-alikes I/L/O/0/1 — which never
 * appear in a real code — are dropped). Returns up to CODE_LEN chars.
 */
export function normalizeRoomCode(input: string): string {
  let out = '';
  for (const ch of input.toUpperCase()) if (ALPHABET.includes(ch)) out += ch;
  return out.slice(0, CODE_LEN);
}

/** True iff `code` is already a valid canonical code. */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== CODE_LEN) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/** Human-friendly rendering, grouped for readability: "ABC-D23". */
export function formatRoomCode(code: string): string {
  const c = code.toUpperCase();
  return c.length === CODE_LEN ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}
