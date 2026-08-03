/**
 * Word-wrap flowing text to a pixel width using a caller-supplied measurer.
 *
 * Content is authored as flowing paragraphs — never with baked-in line breaks —
 * and split into lines HERE, at draw time, against the real rendered width. That
 * keeps the copy resolution-independent and, crucially, language-independent: the
 * same paragraph re-wraps correctly whatever font metrics or translation it's drawn
 * with. `measure` is injected (a bitmap font's glyph-width sum, an HTML canvas
 * measureText, or a fake in tests) so this stays pure and DOM-free.
 */

/**
 * Greedy word wrap. Splits on whitespace, packing as many words per line as fit in
 * `maxWidth`. A single word wider than the line (a long URL, a compound term) is
 * hard-broken by characters so it never overflows. Explicit '\n' in the source force
 * a break (and empty lines are preserved as blank paragraph gaps).
 */
export function wrapWords(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  // A non-positive width can't fit anything meaningful — degrade to one line rather
  // than looping forever on the char-break path below.
  if (!(maxWidth > 0)) return text.split('\n');

  for (const segment of text.split('\n')) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push(''); // blank line — an intentional paragraph gap
      continue;
    }
    let line = '';
    for (let word of words) {
      // Break a word that can't fit on a line by itself, one chunk at a time.
      while (measure(word) > maxWidth && word.length > 1) {
        let cut = word.length;
        while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut--;
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const trial = line ? `${line} ${word}` : word;
      if (line && measure(trial) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
