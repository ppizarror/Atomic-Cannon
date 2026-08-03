/**
 * Changelog screen — "what changed", opened by clicking the version tag on the main menu.
 *
 * Same steel <SectionedDoc> chrome as About and the Manual, but its body is REMOTE: the notes
 * are the project's GitHub releases, fetched and parsed at open time (see net/changelog) rather
 * than living in the string table, so a shipped build shows versions published after it. That
 * means three states to render — loading, unavailable (offline / blocked), and the notes
 * themselves — and only the chrome is localised; the notes are the author's English.
 *
 * The release matching this build is flagged, so a player can see at a glance whether the
 * page they're reading is the game they're running.
 */
import {strings, fmt} from '../i18n';
import {fetchChangelog, RELEASES_PAGE_URL, type ChangelogRelease} from '../net/changelog';
import {BmpText} from './BmpText';
import {BmpParagraph} from './BmpParagraph';
import {SectionedDoc} from './SectionedDoc';
import {useAsyncValue} from './useAsyncValue';

// `useAsyncValue` collapses "still loading" and "failed" into its initial value, which would
// leave the card blank-then-blank on an offline visit — so the load resolves to an explicit
// state instead of a nullable list.
type View = {kind: 'loading'} | {kind: 'error'} | {kind: 'ok'; releases: ChangelogRelease[]};

const loadView = async (): Promise<View> => {
  const releases = await fetchChangelog();
  return releases ? {kind: 'ok', releases} : {kind: 'error'};
};

/** One `-` bulleted note, wrapped to the card width (BmpParagraph re-flows it). */
function Item({text}: {text: string}) {
  return (
    <div class="about-bullet">
      <BmpText font="beijing-16-out" text="-" />
      <BmpParagraph class="about-para" font="beijing-16-out" text={text} />
    </div>
  );
}

function Release({release}: {release: ChangelogRelease}) {
  const c = strings.value.changelog;
  // The build's own release gets the marker. `version` is the release tag with its `v` already
  // stripped (see parseReleases), so it compares directly with the injected package version.
  const isCurrent = release.version === __APP_VERSION__;
  const head = release.date ? `v${release.version}  -  ${release.date}` : `v${release.version}`;
  return (
    <section class={`about-section changelog-release${isCurrent ? ' is-current' : ''}`}>
      <div class="about-sec-head changelog-head">
        <BmpText font="beijing-20-out" text={head} />
        {isCurrent && (
          <span class="changelog-current">
            <BmpText font="beijing-16-out" text={c.current} spacing={-1} />
          </span>
        )}
      </div>
      {release.groups.map((g, i) => (
        <div key={i} class="changelog-group">
          {g.title && (
            <div class="changelog-group-head">
              <BmpText font="beijing-16-out" text={g.title} />
            </div>
          )}
          {g.items.map((text, j) => (
            <Item key={j} text={text} />
          ))}
        </div>
      ))}
    </section>
  );
}

export function Changelog() {
  const c = strings.value.changelog;
  const view = useAsyncValue<View>(loadView, [], {kind: 'loading'});
  return (
    <SectionedDoc title={c.title} subtitle={fmt(c.subtitle, {v: __APP_VERSION__})} sections={[]} back={c.back}>
      {view.kind === 'loading' && (
        <section class="about-section changelog-note">
          <BmpText font="beijing-16-out" text={c.loading} />
        </section>
      )}
      {view.kind === 'error' && (
        <section class="about-section changelog-note">
          <BmpParagraph class="about-para" font="beijing-16-out" text={c.unavailable} />
        </section>
      )}
      {view.kind === 'ok' && view.releases.map(r => <Release key={r.version} release={r} />)}
      <a
        class="changelog-link"
        href={RELEASES_PAGE_URL}
        target="_blank"
        rel="noopener noreferrer"
        title={RELEASES_PAGE_URL}
      >
        <BmpText font="beijing-16-out" text={c.viewSource} />
      </a>
    </SectionedDoc>
  );
}
