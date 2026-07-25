/**
 * The bitmap fonts cover ASCII 33..126 only, so typographic punctuation in authored copy (em/en dash,
 * ellipsis, middle dot, curly quotes, nbsp) would render as blank gaps. asciiFold maps it to ASCII
 * before measure/render so e.g. "Import — load…" reads "Import - load..." instead of "Import  load".
 */
import {describe, it, expect} from 'vitest';
import {asciiFold} from '../src/core/rendering/BitmapFont';

describe('asciiFold', () => {
  it('maps typographic punctuation used in the shipped copy to ASCII', () => {
    expect(asciiFold('Import — load all settings')).toBe('Import - load all settings'); // em dash
    expect(asciiFold('Connecting…')).toBe('Connecting...'); // ellipsis
    expect(asciiFold('top 1000 · bottom 10')).toBe('top 1000 - bottom 10'); // middle dot
    expect(asciiFold('en–dash')).toBe('en-dash');
    expect(asciiFold('‘quote’ “quote”')).toBe(`'quote' "quote"`); // curly quotes
    expect(asciiFold('a b')).toBe('a b'); // non-breaking space → normal space
  });

  it('leaves plain ASCII untouched', () => {
    const s = "Buy - Sell / Auto Buy (200 credits) 100%";
    expect(asciiFold(s)).toBe(s);
  });
});
