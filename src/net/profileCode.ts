/**
 * Profile ids — the 12-char code that names a player's cloud save (settings, controls, players,
 * taunts and high scores). Like a room code, the canonical id *is* the Durable Object name, so
 * every request for a profile routes to the same instance.
 *
 * Longer than a room code's six because the lifetime is completely different: a room lives for
 * one match and its code is read aloud, while a profile id is written down once and kept
 * forever. At 31^12 (~7.9e17) a brute-force scan for other people's saves is hopeless even
 * before the Worker's per-IP rate limit, whereas 31^6 (~8.9e8) would not be.
 */
import {newCode, normalizeCode, isValidCode, groupCode, formatTypedCode} from './codes';
import type {RandInt} from './codes';

export const PROFILE_CODE_LEN = 12;
/** Hyphen position in the display form: "ABCDEF-GHJKMN" (even halves — a written-down code is
 *  easier to copy in two equal chunks than in the room code's 3+3). */
const GROUP_AT = PROFILE_CODE_LEN / 2;

/** Generate a fresh canonical profile id (no separator). */
export const newProfileCode = (randInt?: RandInt): string => newCode(PROFILE_CODE_LEN, randInt);

/** Fold user input to canonical form — uppercase, code chars only, clipped to length. */
export const normalizeProfileCode = (input: string): string => normalizeCode(input, PROFILE_CODE_LEN);

/** True iff `code` is already a valid canonical profile id. */
export const isValidProfileCode = (code: string): boolean => isValidCode(code, PROFILE_CODE_LEN);

/** Human-friendly rendering, grouped for readability: "ABCDEF-GHJKMN". */
export const formatProfileCode = (code: string): string => groupCode(code, PROFILE_CODE_LEN, GROUP_AT);

/** Format a profile id as it's typed into an input (hyphen at the halfway mark). */
export const formatProfileInput = (raw: string, isPaste: boolean): string =>
  formatTypedCode(raw, isPaste, PROFILE_CODE_LEN, GROUP_AT);
