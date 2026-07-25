/**
 * Settings auto-pagination — every category page shows at most PAGE_SIZE (10) real options; any
 * longer list auto-splits into `<base>~<n>` sub-pages, each ending in a free "next page" nav (which
 * does NOT count toward the cap). Locks the "never more than PAGE_SIZE options on a page" invariant
 * and the Graphics layout (Explode Losers on the 3rd page).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {getSettingsPage} from '../src/ui/settingsPages';
import {setController} from '../src/ui/store';
import {CGameController} from '../src/game/CGameController';
import {strings} from '../src/i18n';

const PAGE_SIZE = 10; // must track settingsPages.ts
const CATEGORIES = ['economy', 'tank', 'gameplay', 'graphics', 'audio', 'content'];

// audioRows reads the live controller (game()), so a controller must exist.
setController(new CGameController(makeCanvas()));

describe('Settings auto-pagination', () => {
  it('never shows more than 12 options on any page (the next-page nav is free)', () => {
    for (const base of CATEGORIES) {
      for (let pageIdx = 0; ; pageIdx++) {
        const id = pageIdx === 0 ? base : `${base}~${pageIdx}`;
        const page = getSettingsPage(id);
        expect(page).not.toBeNull();
        if (page!.rows.length === 0) break; // walked past the last sub-page
        const options = page!.rows.filter(r => r.kind !== 'nav');
        expect(options.length).toBeLessThanOrEqual(PAGE_SIZE);
        if (pageIdx > 20) throw new Error('runaway pagination'); // guard
      }
    }
  });

  it('an overflowing category chains sub-pages with a free next-page nav on all but the last', () => {
    // Graphics is the long one: > 20 options → three pages (at PAGE_SIZE 10).
    const p0 = getSettingsPage('graphics')!;
    const p1 = getSettingsPage('graphics~1')!;
    const p2 = getSettingsPage('graphics~2')!;
    const p3 = getSettingsPage('graphics~3')!;

    // Pages 0 and 1 fill to the cap and end in the auto next-page nav; page 2 is the last.
    expect(p0.rows.filter(r => r.kind !== 'nav')).toHaveLength(PAGE_SIZE);
    expect(p0.rows[p0.rows.length - 1].kind).toBe('nav');
    expect(p1.rows[p1.rows.length - 1].kind).toBe('nav');
    expect(p2.rows[p2.rows.length - 1].kind).not.toBe('nav'); // last page: no further nav
    expect(p3.rows).toHaveLength(0); // nothing beyond the last page
  });

  it('Explode Losers sits on the 3rd Graphics page', () => {
    const p3 = getSettingsPage('graphics~2')!; // 0-indexed page 2 = the 3rd page
    const labels = p3.rows.map(r => r.label);
    expect(labels).toContain(strings.value.settings.graphics.explodeLosers.label);
  });
});
