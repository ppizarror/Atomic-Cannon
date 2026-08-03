/**
 * Release-notes reader (src/net/changelog): the URLs derived from the project's `homepage`, and
 * the markdown reduction that turns a GitHub release body into bitmap-font-safe bullet lists.
 * The API shape is fixed by GitHub, so the payload fixtures below are real response fields.
 */
import {describe, it, expect} from 'vitest';
import {parseNotes, parseReleases, releasesApiUrl, releasesPageUrl} from '../src/net/changelog';

const REPO = 'https://github.com/ppizarror/Atomic-Cannon';

describe('release URLs', () => {
  it('derives the API + page URLs from a GitHub project URL', () => {
    expect(releasesApiUrl(REPO)).toBe('https://api.github.com/repos/ppizarror/Atomic-Cannon/releases?per_page=50');
    expect(releasesPageUrl(REPO)).toBe('https://github.com/ppizarror/Atomic-Cannon/releases');
  });

  it('tolerates a trailing slash and http/www variants', () => {
    expect(releasesApiUrl(`${REPO}/`)).toBe(releasesApiUrl(REPO));
    expect(releasesApiUrl('http://www.github.com/ppizarror/Atomic-Cannon')).toBe(releasesApiUrl(REPO));
  });

  it('reports no API for a non-GitHub homepage, and falls back to it for the page link', () => {
    expect(releasesApiUrl('https://example.com/game')).toBe('');
    expect(releasesPageUrl('https://example.com/game')).toBe('https://example.com/game');
  });
});

describe('parseNotes', () => {
  it('reads a plain bullet list into one untitled group', () => {
    const groups = parseNotes('- Add random position/firepower.\r\n- Fix damage model.');
    expect(groups).toEqual([{title: '', items: ['Add random position/firepower.', 'Fix damage model.']}]);
  });

  it('opens a group per heading', () => {
    const groups = parseNotes('### Added\n- Homing Missile\n- Katyusha\n\n### Fixed\n- Radiation cleanup');
    expect(groups).toEqual([
      {title: 'Added', items: ['Homing Missile', 'Katyusha']},
      {title: 'Fixed', items: ['Radiation cleanup']},
    ]);
  });

  it('strips the inline markdown the bitmap fonts cannot draw', () => {
    const groups = parseNotes('- **Homing Missile** — see `CShot` and [the docs](https://example.com/d)');
    expect(groups[0].items[0]).toBe('Homing Missile — see CShot and the docs');
  });

  it('joins a hard-wrapped item back into one flowing line', () => {
    const groups = parseNotes('- Particles now run on the GPU,\n  which holds framerate\n  during big blasts.');
    expect(groups[0].items).toEqual(['Particles now run on the GPU, which holds framerate during big blasts.']);
  });

  it("drops GitHub's auto-generated compare footer", () => {
    const body =
      '**Full Changelog**: https://github.com/ppizarror/Atomic-Cannon/compare/v3.0.6...v3.0.7\r\n\r\n- Real note.';
    expect(parseNotes(body)).toEqual([{title: '', items: ['Real note.']}]);
  });

  it('keeps a prose-only body as its own items, and returns nothing for an empty one', () => {
    expect(parseNotes('Initial release!')).toEqual([{title: '', items: ['Initial release!']}]);
    expect(parseNotes('')).toEqual([]);
    expect(parseNotes('### Added\n\n### Fixed')).toEqual([]); // headings with no items at all
  });
});

describe('parseReleases', () => {
  const payload = [
    {tag_name: 'v3.1.0', published_at: '2026-08-03T02:27:52Z', body: '- Homing Missile.'},
    {tag_name: 'v3.0.7', published_at: '2026-07-30T02:27:52Z', body: '- Fix damage model.'},
  ];

  it('strips the tag prefix and reduces the timestamp to a day', () => {
    expect(parseReleases(payload)).toEqual([
      {version: '3.1.0', date: '2026-08-03', groups: [{title: '', items: ['Homing Missile.']}]},
      {version: '3.0.7', date: '2026-07-30', groups: [{title: '', items: ['Fix damage model.']}]},
    ]);
  });

  it('skips drafts and untagged entries, and keeps a release whose notes are empty', () => {
    const out = parseReleases([
      {tag_name: 'v9.9.9', draft: true, body: '- Secret.'},
      {body: '- No tag, no release.'},
      {tag_name: 'v3.0.3', created_at: '2026-07-25T07:47:17Z', body: ''},
    ]);
    expect(out).toEqual([{version: '3.0.3', date: '2026-07-25', groups: []}]);
  });

  it('returns nothing for a non-array payload (an API error object)', () => {
    expect(parseReleases({message: 'API rate limit exceeded'})).toEqual([]);
    expect(parseReleases(null)).toEqual([]);
  });
});
