/**
 * Profile ids: the 12-char cloud-save code. Same generator as room codes (shared `net/codes`),
 * so this covers the length/grouping specialisation and the round-trip a player actually
 * performs — read the formatted id off one screen, type it into another.
 */
import {describe, it, expect} from 'vitest';
import {Prng} from '../src/math/prng';
import {
  PROFILE_CODE_LEN,
  newProfileCode,
  normalizeProfileCode,
  isValidProfileCode,
  formatProfileCode,
  formatProfileInput,
} from '../src/net/profileCode';
import {newRoomCode} from '../src/net/roomCode';

const seededRandInt = (p: Prng) => (n: number) => p.int(n);

describe('profileCode', () => {
  it('generates valid full-length ids with no ambiguous glyphs', () => {
    const ri = seededRandInt(new Prng(4242));
    for (let i = 0; i < 2000; i++) {
      const code = newProfileCode(ri);
      expect(code).toHaveLength(PROFILE_CODE_LEN);
      expect(isValidProfileCode(code)).toBe(true);
      expect(/[ILO01]/.test(code)).toBe(false);
    }
  });

  it('is longer than a room code — the two are not interchangeable', () => {
    const p = new Prng(11);
    // A room code must never validate as a profile id: they name different Durable Objects, and
    // the extra length is what makes a profile id impractical to guess.
    expect(isValidProfileCode(newRoomCode(seededRandInt(p)))).toBe(false);
    expect(PROFILE_CODE_LEN).toBeGreaterThan(6);
  });

  it('normalizes typed/pasted input to canonical form', () => {
    expect(normalizeProfileCode('abcdef-ghjkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeProfileCode(' A B C D E F G H J K M N ')).toBe('ABCDEFGHJKMN');
    // Excluded glyphs are dropped rather than mapped, so a typo can't silently become a real id.
    expect(normalizeProfileCode('OIL')).toBe('');
    // Over-long input is clipped.
    expect(normalizeProfileCode('ABCDEFGHJKMNPQ')).toBe('ABCDEFGHJKMN');
  });

  it('validates length and alphabet', () => {
    expect(isValidProfileCode('ABCDEFGHJKMN')).toBe(true);
    expect(isValidProfileCode('ABCDEFGHJKM')).toBe(false); // one short
    expect(isValidProfileCode('ABCDEFGHJKMNP')).toBe(false); // one long
    expect(isValidProfileCode('ABCDEFGHJKM0')).toBe(false); // 0 excluded
    expect(isValidProfileCode('abcdefghjkmn')).toBe(false); // lowercase isn't canonical
  });

  it('formats as even halves', () => {
    expect(formatProfileCode('ABCDEFGHJKMN')).toBe('ABCDEF-GHJKMN');
    expect(formatProfileCode('abcdefghjkmn')).toBe('ABCDEF-GHJKMN');
    // A partial id isn't grouped — it isn't a real code yet.
    expect(formatProfileCode('ABCDEF')).toBe('ABCDEF');
  });

  it('auto-hyphenates while typing (but leaves a paste alone)', () => {
    expect(formatProfileInput('abcde', false)).toBe('ABCDE');
    expect(formatProfileInput('abcdef', false)).toBe('ABCDEF');
    expect(formatProfileInput('abcdefg', false)).toBe('ABCDEF-G');
    expect(formatProfileInput('abcdefghjkmn', false)).toBe('ABCDEF-GHJKMN');
    // Backspacing past the hyphen must not re-add it (no stuck state).
    expect(formatProfileInput('ABCDEF', false)).toBe('ABCDEF');
    // A paste passes through; normalize handles it on submit.
    expect(formatProfileInput('ABCDEF-GHJKMN', true)).toBe('ABCDEF-GHJKMN');
  });

  it('round-trips: what one device shows, another can type back in', () => {
    const code = newProfileCode(seededRandInt(new Prng(99)));
    const shown = formatProfileCode(code);
    expect(normalizeProfileCode(shown)).toBe(code);
    expect(isValidProfileCode(normalizeProfileCode(shown))).toBe(true);
  });
});
