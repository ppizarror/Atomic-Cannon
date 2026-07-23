/**
 * Word wrap — the About screen packs flowing paragraphs into lines that fit a pixel
 * width, using an injected measurer. Uses a fake 10px/char monospace measure so the
 * arithmetic is exact and DOM-free.
 */
import {describe, it, expect} from 'vitest';
import {wrapWords} from '../src/core/rendering/wrapText';

// Each character is 10px wide (spaces included) — trivial, deterministic metrics.
const mono = (s: string) => s.length * 10;

describe('wrapWords', () => {
  it('packs as many words per line as fit the width', () => {
    // 100px = 10 chars. "aaa bbb" is 7 chars (fits); adding " ccc" is 11 (overflows).
    expect(wrapWords('aaa bbb ccc', 100, mono)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps everything on one line when it fits', () => {
    expect(wrapWords('one two', 1000, mono)).toEqual(['one two']);
  });

  it('hard-breaks a single word wider than the line', () => {
    // 40px = 4 chars; the 9-char word can't fit, so it splits into 4/4/1.
    expect(wrapWords('abcdefghi', 40, mono)).toEqual(['abcd', 'efgh', 'i']);
  });

  it('breaks an over-long word even mid-line, flushing the pending line first', () => {
    // "hi " fits, then the long word overflows and is broken into chunks.
    expect(wrapWords('hi abcdefghi', 40, mono)).toEqual(['hi', 'abcd', 'efgh', 'i']);
  });

  it('preserves explicit newlines as blank paragraph gaps', () => {
    expect(wrapWords('a\n\nb', 1000, mono)).toEqual(['a', '', 'b']);
  });

  it('does not loop forever on a non-positive width', () => {
    expect(wrapWords('a b', 0, mono)).toEqual(['a b']);
  });

  it('collapses runs of whitespace between words', () => {
    expect(wrapWords('a   b', 1000, mono)).toEqual(['a b']);
  });
});
