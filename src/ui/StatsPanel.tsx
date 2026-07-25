/**
 * Global play-stats panel on the About screen. Fetches the aggregate (`GET /api/stats`) once and
 * shows the "nerdy" counters, a world BUBBLE map of games-per-country (equirectangular; dot area ∝
 * games, so no map asset is needed), and a ranked country list (flag + name + bar). Best-effort: if
 * the fetch fails (offline / not deployed) it quietly shows an "unavailable" line.
 */
import {strings, fmt} from '../i18n';
import {BmpText} from './BmpText';
import {useAsyncValue} from './useAsyncValue';
import {fetchStats, type StatsSnapshot} from '../net/stats';
import {flagEmoji, countryName, loadWorldPaths} from './worldGeo';

const nf = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Seconds → compact "1d 3h" / "2h 5m" / "40s". */
function dur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function Row({label, value}: {label: string; value: string}) {
  return (
    <div class="stat-row">
      <span class="stat-label">
        <BmpText font="beijing-16-out" text={label} spacing={-1} />
      </span>
      <span class="stat-value">
        <BmpText font="beijing-16-out" text={value} spacing={-1} />
      </span>
    </div>
  );
}

/** Equirectangular CHOROPLETH (x = lng+180, y = 90-lat): a real 110m world map where each country is
 *  filled by its game count — more games → greener. Countries with no games sit at a faint base. */
function WorldMap({countries}: {countries: Record<string, number>}) {
  const c = strings.value.about.stats;
  const world = useAsyncValue(loadWorldPaths, [], []);
  const max = Math.max(
    1,
    ...Object.entries(countries)
      .filter(([cc]) => cc !== 'XX')
      .map(([, n]) => n),
  );
  const anyGames = Object.entries(countries).some(([cc, n]) => cc !== 'XX' && n > 0);

  // Fill for a country: transparent (base class shows through) when it has no games; otherwise a
  // green whose opacity ramps with √(count/max) so a single game still reads and a busy country pops.
  const fillOf = (cc: string): string | undefined => {
    const n = cc && cc !== 'XX' ? (countries[cc] ?? 0) : 0;
    if (n <= 0) return undefined;
    const a = (0.3 + 0.65 * Math.sqrt(n / max)).toFixed(2);
    return `rgba(90, 230, 120, ${a})`;
  };

  return (
    <svg class="stat-map" viewBox="0 0 360 180" preserveAspectRatio="xMidYMid meet" role="img">
      <rect x="0" y="0" width="360" height="180" class="stat-map-bg" />
      {/* faint graticule for a sense of the globe */}
      {[45, 90, 135].map(y => (
        <line key={`h${y}`} x1="0" y1={y} x2="360" y2={y} class="stat-map-grid" />
      ))}
      {[90, 180, 270].map(x => (
        <line key={`v${x}`} x1={x} y1="0" x2={x} y2="180" class="stat-map-grid" />
      ))}
      {/* the world: every country, filled by its game count */}
      {world.map(({cc, d}, i) => {
        const fill = fillOf(cc);
        return (
          <path key={i} d={d} class="stat-map-land" style={fill ? {fill} : undefined}>
            {fill && <title>{`${countryName(cc)}: ${nf(countries[cc])}`}</title>}
          </path>
        );
      })}
      {!anyGames && (
        <text x="180" y="94" class="stat-map-empty" text-anchor="middle">
          {c.mapEmpty}
        </text>
      )}
    </svg>
  );
}

function CountryList({countries}: {countries: Record<string, number>}) {
  const rows = Object.entries(countries)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const max = rows.reduce((m, [, n]) => Math.max(m, n), 1);
  return (
    <div class="stat-countries">
      {rows.map(([cc, n]) => (
        <div key={cc} class="stat-country">
          <span class="stat-flag">{flagEmoji(cc)}</span>
          <span class="stat-cname">
            <BmpText font="beijing-16-out" text={countryName(cc)} spacing={-1} />
          </span>
          <span class="stat-bar-wrap">
            <span class="stat-bar" style={{width: `${(n / max) * 100}%`}} />
          </span>
          <span class="stat-cnum">
            <BmpText font="beijing-16-out" text={nf(n)} spacing={-1} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function StatsPanel() {
  const c = strings.value.about.stats;
  const stats = useAsyncValue<StatsSnapshot | null>(fetchStats, [], null);

  // useAsyncValue starts at null and stays null on failure — so when there's no data we still show
  // the (empty) world map, just with an "offline" line instead of the counters.
  const t = stats?.totals;
  const countries = stats?.countries ?? {};
  const countryCount = Object.keys(countries).filter(k => k !== 'XX').length;

  return (
    <div class="stat-panel">
      {t ? (
        <div class="stat-grid">
          <Row label={c.games} value={nf(t.games)} />
          <Row label={c.onlineGames} value={nf(t.onlineGames)} />
          <Row label={c.tanksDestroyed} value={nf(t.tanksDestroyed)} />
          <Row label={c.weaponsFired} value={nf(t.weaponsFired)} />
          <Row label={c.shotsFired} value={nf(t.shotsFired)} />
          <Row label={c.damageDealt} value={nf(t.damageDealt)} />
          <Row label={c.nukesFired} value={nf(t.nukesFired)} />
          <Row label={c.terrainCarved} value={nf(t.terrainCarved)} />
          <Row label={c.creditsSpent} value={nf(t.creditsSpent)} />
          <Row label={c.playTime} value={dur(t.playTimeSec)} />
          <Row label={c.longestGame} value={dur(t.longestGameSec)} />
        </div>
      ) : (
        <div class="stat-empty">
          <BmpText font="beijing-16-out" text={c.unavailable} spacing={-1} />
        </div>
      )}

      <div class="stat-map-head">
        <BmpText font="beijing-16-out" text={fmt(c.byCountry, {n: countryCount})} spacing={-1} />
      </div>
      <WorldMap countries={countries} />
      {countryCount > 0 && <CountryList countries={countries} />}
    </div>
  );
}
