/**
 * Geo helpers for the About "games per country" CHOROPLETH. A country's flag emoji and English name
 * are DERIVED from its ISO-3166-1 alpha-2 code (regional-indicator emoji + Intl.DisplayNames — no
 * flag sprites or name table). The world outline is a low-res (Natural Earth 110m) GeoJSON asset with
 * the alpha-2 code baked into each feature (see /tmp/conv2.js), so the map colours a country directly
 * by its game count. Loaded lazily (only when About opens).
 */

/** ISO alpha-2 → 🇺🇸-style flag emoji (two regional-indicator symbols). '' for a non A–Z code. */
export function flagEmoji(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return '🏳️';
  const A = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(A + up.charCodeAt(0) - 65, A + up.charCodeAt(1) - 65);
}

let regionNames: Intl.DisplayNames | null = null;
/** English country name from its code (e.g. 'CL' → 'Chile'); falls back to the code itself. */
export function countryName(cc: string): string {
  if (cc === 'XX') return 'Unknown';
  try {
    regionNames ??= new Intl.DisplayNames(['en'], {type: 'region'});
    return regionNames.of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

// ── World map (lazy) ──────────────────────────────────────────────────────────
// A low-res (Natural Earth 110m) world map, shipped as a static GeoJSON asset and loaded only when
// the About screen opens. Each country becomes one SVG path (equirectangular: x = lng+180, y = 90−lat)
// tagged with its alpha-2 code, so the choropleth can fill it by game count.

type Ring = [number, number][];
interface GeoFeature {
  properties: {cc: string; name?: string};
  geometry: {type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][]};
}

/** One country ready to draw: its alpha-2 code (may be '' for a few disputed areas) + its SVG path. */
export interface WorldCountry {
  cc: string;
  d: string;
}

/** Project one ring to an SVG subpath in the 360×180 viewBox. Breaks the line (a fresh `M`) wherever
 *  consecutive points jump more than half the map in longitude — i.e. a country crossing the ±180°
 *  antimeridian (Russia, Fiji, Antarctica) — so it never draws a streak straight across the map. */
function ringPath(r: Ring): string {
  let d = '';
  let px = NaN;
  let broke = false;
  for (const [lng, lat] of r) {
    const x = lng + 180;
    const y = 90 - lat;
    if (d === '') {
      d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    } else if (Math.abs(x - px) > 180) {
      d += `M${x.toFixed(1)} ${y.toFixed(1)}`; // seam crossing → break, don't connect across the map
      broke = true;
    } else {
      d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    px = x;
  }
  return broke ? d : d + 'Z'; // only close rings that didn't straddle the seam
}

function featurePath(g: GeoFeature['geometry']): string {
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as Ring[][];
  return polys.map(poly => poly.map(ringPath).join('')).join('');
}

let worldPromise: Promise<WorldCountry[]> | null = null;

/** Fetch (once) the world GeoJSON → one {cc, path} per country. [] on any failure. */
export function loadWorldPaths(): Promise<WorldCountry[]> {
  worldPromise ??= fetch('/assets/world-110m.geojson')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('no world map'))))
    .then(fc => {
      const {features} = fc as {features: GeoFeature[]};
      return features.map(f => ({cc: f.properties.cc, d: featurePath(f.geometry)}));
    })
    .catch(() => [] as WorldCountry[]);
  return worldPromise;
}
