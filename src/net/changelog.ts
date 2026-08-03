/**
 * Release notes — the document behind the version tag on the main menu (see ui/Changelog).
 *
 * There is no changelog file in this repository on purpose: the notes ARE the GitHub releases,
 * which is where they get written anyway when a version is tagged. The screen reads them live
 * from the repository's releases API, so a deployed build shows versions published after it
 * shipped and nothing has to be kept in step with anything.
 *
 * Fetched straight from the browser rather than proxied through the Worker: `api.github.com`
 * sends `Access-Control-Allow-Origin: *`, so it works in plain `pnpm dev` with no backend. The
 * cost is GitHub's unauthenticated budget of 60 requests/hour PER CLIENT IP — far beyond what a
 * player clicking a version tag will spend (and this module caches the result for the session),
 * but a shared-NAT visitor who runs into it simply gets the "unavailable" state.
 *
 * A release BODY is markdown, so it still has to be read: any heading opens a group, `-`/`*`
 * opens an item, and inline markdown is stripped rather than rendered — the screen draws with
 * the game's bitmap fonts, which have no bold and no links.
 */

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** One heading inside a release's notes, and the list items under it. `title` is '' for items
 *  written at the top of the body with no heading of their own. */
export interface ChangelogGroup {
  title: string;
  items: string[];
}

/** One published release: its version (the tag, `v` stripped), its publication date as
 *  `YYYY-MM-DD` ('' if GitHub reports none), and its parsed notes. */
export interface ChangelogRelease {
  version: string;
  date: string;
  groups: ChangelogGroup[];
}

/** The fields this screen reads out of a GitHub release object — the response carries far more
 *  (author, assets, upload URLs), all of it ignored. */
interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  published_at?: string;
  created_at?: string;
}

// ==========================================================================
// SOURCE URLS
// ==========================================================================

/** How many releases to ask for — the whole history, comfortably, in one request. */
const PER_PAGE = 50;

/** `owner/repo` for a `https://github.com/owner/repo` project URL, or '' if it isn't one. */
function repoSlug(repoUrl: string): string {
  const base = repoUrl.replace(/\/+$/, '');
  const gh = /^https?:\/\/(?:www\.)?github\.com\//.exec(base);
  return gh ? base.slice(gh[0].length) : '';
}

/**
 * The releases API endpoint for a project URL. Derived rather than hard-coded so a fork only has
 * to change `package.json`'s `homepage` — the same field the main menu's repo link is built from.
 * Empty when the URL isn't a GitHub project, which the fetch treats as "no notes available".
 */
export function releasesApiUrl(repoUrl: string): string {
  const slug = repoSlug(repoUrl);
  return slug ? `https://api.github.com/repos/${slug}/releases?per_page=${PER_PAGE}` : '';
}

/** The human-facing releases page, for the footer link and the offline fallback. */
export function releasesPageUrl(repoUrl: string): string {
  const slug = repoSlug(repoUrl);
  return slug ? `https://github.com/${slug}/releases` : repoUrl;
}

/** Where this build reads its notes from, and where it sends a player who wants the full page. */
export const RELEASES_API_URL = releasesApiUrl(__REPO_URL__);
export const RELEASES_PAGE_URL = releasesPageUrl(__REPO_URL__);

// ==========================================================================
// PARSING
// ==========================================================================

/** Drop the inline markdown the bitmap fonts can't express — code spans, links (kept as their
 *  text), bold and italic — and collapse whitespace so a hard-wrapped source line reads as one
 *  flowing sentence. */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![*\w])[*_](?=\S)(.+?\S)[*_](?![*\w])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** GitHub's auto-generated "Full Changelog: <compare URL>" footer. It is a bare URL once the
 *  link markup is stripped, which reads as noise in a bitmap font — and the screen already
 *  carries a link out to the releases page. */
const isBoilerplate = (line: string): boolean => /^full changelog\s*:/i.test(line);

/**
 * Read one release BODY into groups. Any heading (`#`..`######`) opens a group, `-`/`*`/`+`
 * opens an item, and a plain line continues the item above it (or stands alone as its own,
 * for a body written as prose rather than a list).
 */
export function parseNotes(body: string): ChangelogGroup[] {
  const groups: ChangelogGroup[] = [];
  let group: ChangelogGroup | null = null;
  let item = -1; // index in group.items of the item a continuation line would extend

  /** The group the next item belongs to, opening an untitled one if the body has none yet. */
  const current = (): ChangelogGroup => {
    if (!group) {
      group = {title: '', items: []};
      groups.push(group);
    }
    return group;
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      item = -1; // a blank line closes the current item; the next prose starts a new one
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      group = {title: stripInline(heading[1]), items: []};
      groups.push(group);
      item = -1;
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const text = stripInline(bullet ? bullet[1] : line);
    if (!text || isBoilerplate(text)) {
      if (bullet) item = -1;
      continue;
    }
    const g = current();
    // A plain line under an OPEN item is that item's wrapped continuation; everything else
    // (a bullet, or prose after a blank line) starts a new item.
    if (!bullet && item >= 0) g.items[item] = `${g.items[item]} ${text}`;
    else item = g.items.push(text) - 1;
  }

  return groups.filter(g => g.items.length > 0);
}

/** Fold the API payload into the shape the screen renders. Drafts are dropped (they are not
 *  public notes), and a release with an unusable tag is skipped rather than shown as "v". */
export function parseReleases(payload: unknown): ChangelogRelease[] {
  if (!Array.isArray(payload)) return [];
  const out: ChangelogRelease[] = [];
  for (const r of payload as GitHubRelease[]) {
    if (!r || typeof r !== 'object' || r.draft) continue;
    const version = String(r.tag_name ?? r.name ?? '')
      .trim()
      .replace(/^v/i, '');
    if (!version) continue;
    // GitHub sends an ISO instant; the notes only ever want the day.
    const date = String(r.published_at ?? r.created_at ?? '').slice(0, 10);
    out.push({version, date, groups: parseNotes(String(r.body ?? ''))});
  }
  return out;
}

// ==========================================================================
// FETCH
// ==========================================================================

// Remembered for the session so re-opening the screen doesn't spend another request. Only a
// SUCCESS is cached: a transient offline moment must not poison the screen until a page reload.
let cached: ChangelogRelease[] | null = null;
let inFlight: Promise<ChangelogRelease[] | null> | null = null;

async function load(): Promise<ChangelogRelease[] | null> {
  if (!RELEASES_API_URL) return null; // the project URL isn't a GitHub repo — nothing to read
  try {
    const r = await fetch(RELEASES_API_URL, {headers: {accept: 'application/vnd.github+json'}});
    if (!r.ok) return null; // 403 = the hourly budget is spent; anything else is just as fatal
    const releases = parseReleases(await r.json());
    return releases.length ? releases : null;
  } catch {
    return null; // offline / blocked — the screen shows its "unavailable" line
  }
}

/** The published releases, newest first, or null when they can't be read. Never throws; costs
 *  one request per session once it succeeds. */
export function fetchChangelog(): Promise<ChangelogRelease[] | null> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= load().then(releases => {
    inFlight = null;
    if (releases) cached = releases;
    return releases;
  });
  return inFlight;
}
