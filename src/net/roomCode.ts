/**
 * Room codes — the shareable "send this to your friends" join key. On
 * Cloudflare the canonical code *is* the Durable Object name, so every socket
 * for a code routes to the same room instance.
 *
 * A 6-char specialisation of the shared generator in `codes.ts` (which also backs the 10-char
 * profile id); the alphabet, the rejection-sampled RNG and the typing formatter all live there.
 */
import {CODE_ALPHABET, newCode, normalizeCode, isValidCode, groupCode, formatTypedCode} from './codes';
import type {RandInt} from './codes';

export {cryptoRandInt} from './codes';
export type {RandInt};

const CODE_LEN = 6;
/** Hyphen position in the display form: "ABC-D23". */
const GROUP_AT = 3;

/** The room-code alphabet (re-exported so callers don't reach past this module). */
export const ROOM_ALPHABET = CODE_ALPHABET;

/** Generate a fresh canonical room code (6 chars, no separator). */
export const newRoomCode = (randInt?: RandInt): string => newCode(CODE_LEN, randInt);

/** Fold user input to canonical form — uppercase, code chars only, up to 6. */
export const normalizeRoomCode = (input: string): string => normalizeCode(input, CODE_LEN);

/** True iff `code` is already a valid canonical room code. */
export const isValidRoomCode = (code: string): boolean => isValidCode(code, CODE_LEN);

/** Human-friendly rendering, grouped for readability: "ABC-D23". */
export const formatRoomCode = (code: string): string => groupCode(code, CODE_LEN, GROUP_AT);

/** Format a room code as it's typed into an input (hyphen after the 3rd letter). */
export const formatCodeInput = (raw: string, isPaste: boolean): string =>
  formatTypedCode(raw, isPaste, CODE_LEN, GROUP_AT);
