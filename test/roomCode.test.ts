/**
 * Room codes: generated codes are always valid and never contain the ambiguous
 * glyphs (I/L/O/0/1); normalize folds pasted/typed input (hyphens, spaces, case)
 * back to canonical; validate and format behave.
 */
import {describe, it, expect} from 'vitest';
import {Prng} from '../src/math/prng';
import {newRoomCode, normalizeRoomCode, isValidRoomCode, formatRoomCode, formatCodeInput} from '../src/net/roomCode';

const seededRandInt = (p: Prng) => (n: number) => p.int(n);

describe('roomCode', () => {
  it('generates valid 6-char codes with no ambiguous glyphs', () => {
    const p = new Prng(2024);
    const ri = seededRandInt(p);
    for (let i = 0; i < 2000; i++) {
      const code = newRoomCode(ri);
      expect(code).toHaveLength(6);
      expect(isValidRoomCode(code)).toBe(true);
      expect(/[ILO01]/.test(code)).toBe(false);
    }
  });

  it('is deterministic under a seeded source (reproducible in tests)', () => {
    const a = newRoomCode(seededRandInt(new Prng(7)));
    const b = newRoomCode(seededRandInt(new Prng(7)));
    expect(a).toBe(b);
  });

  it('normalizes typed/pasted input to canonical form', () => {
    expect(normalizeRoomCode('abc-d23')).toBe('ABCD23');
    expect(normalizeRoomCode('  A B C D 2 3 ')).toBe('ABCD23');
    expect(normalizeRoomCode('ABC-D23')).toBe('ABCD23');
    // excluded glyphs are dropped (they never appear in real codes)
    expect(normalizeRoomCode('OIL')).toBe('');
    // over-long input is clipped to 6
    expect(normalizeRoomCode('ABCDEFGH')).toBe('ABCDEF');
  });

  it('validates length and alphabet', () => {
    expect(isValidRoomCode('ABCD23')).toBe(true);
    expect(isValidRoomCode('ABCD2')).toBe(false); // too short
    expect(isValidRoomCode('ABCD2X')).toBe(true);
    expect(isValidRoomCode('ABCD20')).toBe(false); // 0 excluded
    expect(isValidRoomCode('abcd23')).toBe(false); // lowercase not canonical
  });

  it('formats with a mid-group hyphen', () => {
    expect(formatRoomCode('ABCD23')).toBe('ABC-D23');
    expect(formatRoomCode('abcd23')).toBe('ABC-D23');
  });

  it('auto-hyphenates while typing (but leaves a paste alone)', () => {
    // Typing: hyphen appears once past the 3rd char; ≤3 stays plain (so backspace works).
    expect(formatCodeInput('ab', false)).toBe('AB');
    expect(formatCodeInput('abc', false)).toBe('ABC');
    expect(formatCodeInput('abcd', false)).toBe('ABC-D');
    expect(formatCodeInput('abcd23', false)).toBe('ABC-D23');
    // Backspacing "ABC-" → "ABC" must not re-add the dash (no stuck state).
    expect(formatCodeInput('ABC', false)).toBe('ABC');
    // A paste is passed through (normalizeRoomCode handles it on submit).
    expect(formatCodeInput('ABC-D23', true)).toBe('ABC-D23');
    expect(formatCodeInput('abcd23', true)).toBe('ABCD23');
  });

  it('normalize→validate round-trips a formatted code', () => {
    const code = newRoomCode(seededRandInt(new Prng(99)));
    const shown = formatRoomCode(code);
    expect(normalizeRoomCode(shown)).toBe(code);
    expect(isValidRoomCode(normalizeRoomCode(shown))).toBe(true);
  });
});
