/**
 * Which rows the top-left status overlay prints. Up to the row cap every team is listed; past it
 * the list is cut to the acting player's row alone (the original's behaviour), or — with Scroll
 * Status List on (Graphics) — to a window that rolls forward with the turn.
 */
import {describe, it, expect} from 'vitest';
import {statusWindow} from '../src/ui/store';

/** `n` rows named 1..n, with `activeIdx` marked as the acting player. */
const rows = (n: number, activeIdx: number) =>
  Array.from({length: n}, (_, i) => ({name: String(i + 1), active: i === activeIdx}));

const names = (r: {name: string}[]) => r.map(x => x.name).join(',');

describe('status overlay window', () => {
  it('lists everyone while the roster fits', () => {
    const r = rows(4, 0);
    expect(names(statusWindow(r, {compact: false, scroll: false, rows: 4}))).toBe('1,2,3,4');
    // The scroll option only ever matters once the list is compact.
    expect(names(statusWindow(r, {compact: false, scroll: true, rows: 4}))).toBe('1,2,3,4');
  });

  it('compact without scrolling: the acting row alone', () => {
    expect(names(statusWindow(rows(13, 0), {compact: true, scroll: false, rows: 4}))).toBe('1');
    expect(names(statusWindow(rows(13, 6), {compact: true, scroll: false, rows: 4}))).toBe('7');
  });

  it('compact with scrolling: the window rolls forward with the turn', () => {
    const w = (activeIdx: number) => names(statusWindow(rows(13, activeIdx), {compact: true, scroll: true, rows: 4}));
    expect(w(0)).toBe('1,2,3,4'); // player 1 acting
    expect(w(1)).toBe('2,3,4,5'); // …player 1 done, the list steps on
    expect(w(2)).toBe('3,4,5,6');
    expect(w(8)).toBe('9,10,11,12');
  });

  it('the window wraps past the end instead of running short', () => {
    const w = (activeIdx: number) => names(statusWindow(rows(13, activeIdx), {compact: true, scroll: true, rows: 4}));
    expect(w(10)).toBe('11,12,13,1'); // rolls around to the top
    expect(w(12)).toBe('13,1,2,3');
  });

  it('never prints more rows than there are teams', () => {
    // Defensive: compact implies more teams than rows, but a shrinking roster must not repeat rows.
    const out = statusWindow(rows(3, 1), {compact: true, scroll: true, rows: 4});
    expect(names(out)).toBe('2,3,1');
    expect(new Set(out.map(x => x.name)).size).toBe(3); // each team at most once
  });

  it('falls back to the top of the list when no row is active', () => {
    expect(names(statusWindow(rows(13, -1), {compact: true, scroll: true, rows: 4}))).toBe('1,2,3,4');
    expect(statusWindow([], {compact: true, scroll: true, rows: 4})).toEqual([]);
  });
});
