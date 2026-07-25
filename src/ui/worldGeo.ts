/**
 * Tiny geo helpers for the About "games per country" map — asset-free. A country's flag emoji and
 * English name are DERIVED from its ISO-3166-1 alpha-2 code (regional-indicator emoji + the platform
 * Intl.DisplayNames), so no flag sprites or name table are shipped. For the bubble map we only need
 * an approximate lat/long centroid per country; the table below covers the common ones (anything not
 * listed still appears in the ranked list, just without a map dot).
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

/** Approximate [lat, lng] centroid per country, for placing a map dot. Not exhaustive — a country
 *  without an entry is simply omitted from the map (it still shows in the ranked list). */
export const CENTROIDS: Record<string, [number, number]> = {
  US: [39, -98],
  CA: [56, -106],
  MX: [23, -102],
  BR: [-10, -55],
  AR: [-38, -63],
  CL: [-31, -71],
  CO: [4, -73],
  PE: [-9, -75],
  VE: [7, -66],
  EC: [-1, -78],
  BO: [-17, -64],
  PY: [-23, -58],
  UY: [-33, -56],
  GB: [54, -2],
  IE: [53, -8],
  FR: [46, 2],
  ES: [40, -4],
  PT: [39, -8],
  DE: [51, 10],
  IT: [42, 12],
  NL: [52, 5],
  BE: [50, 4],
  CH: [47, 8],
  AT: [47, 14],
  SE: [62, 15],
  NO: [61, 8],
  FI: [64, 26],
  DK: [56, 9],
  PL: [52, 19],
  CZ: [49, 15],
  SK: [48, 19],
  HU: [47, 19],
  RO: [46, 25],
  BG: [42, 25],
  GR: [39, 22],
  UA: [49, 32],
  RU: [61, 90],
  TR: [39, 35],
  BY: [53, 28],
  RS: [44, 21],
  HR: [45, 15],
  IS: [65, -18],
  EE: [59, 26],
  LV: [57, 25],
  LT: [55, 24],
  CN: [35, 105],
  JP: [36, 138],
  KR: [37, 128],
  IN: [22, 79],
  ID: [-2, 118],
  PH: [13, 122],
  TH: [15, 101],
  VN: [16, 108],
  MY: [4, 102],
  SG: [1, 104],
  PK: [30, 70],
  BD: [24, 90],
  TW: [24, 121],
  HK: [22, 114],
  AE: [24, 54],
  SA: [24, 45],
  IL: [31, 35],
  IR: [32, 53],
  IQ: [33, 44],
  KZ: [48, 68],
  AU: [-25, 134],
  NZ: [-42, 173],
  ZA: [-30, 25],
  EG: [27, 30],
  NG: [10, 8],
  KE: [0, 38],
  MA: [32, -6],
  DZ: [28, 3],
  TN: [34, 9],
  GH: [8, -1],
  ET: [8, 40],
  TZ: [-6, 35],
  AO: [-12, 18],
  MZ: [-18, 35],
};
