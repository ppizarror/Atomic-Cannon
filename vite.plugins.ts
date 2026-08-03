/**
 * Build-time prune for `dist/`.
 *
 * Vite's `publicDir` copy is verbatim: it mirrors whatever sits on disk into `dist/`, and wrangler
 * then uploads the whole directory. Two kinds of file ride along that shouldn't reach Cloudflare.
 *
 *  1. **`.DS_Store`** — Finder metadata. It IS gitignored, but publicDir copies from the DISK, not
 *     from git, so ignoring it buys nothing here. Each one is publicly fetchable and lists the
 *     names of everything in its directory. Always removed.
 *
 *  2. **Assets nothing references.** Reported by default and only deleted when `PRUNE_ASSETS=1`,
 *     so the list is visible before anything is destroyed.
 *
 * The unused set is derived from the SAME JSON the game reads, so it cannot drift: give a weapon
 * `expBitmap: "08.bmp"` and flare 08 is kept automatically. As a second guard, nothing is dropped
 * whose path or filename appears anywhere under `src/` — that covers assets wired up by a literal
 * path in code rather than by data (`flares/04.bmp`, `land/ldirt1.bmp`, …).
 *
 * Only directories whose reference set is FULLY derivable from data are eligible (see PRUNABLE).
 * Fonts, bursts, tanks, sounds and music are deliberately excluded: their registries hold bare
 * names (`file: 'Arial 14'`, `NAMES: ['circle', …]`) rather than filenames, so a
 * derive-and-delete pass would wrongly condemn every one of them.
 */
import {readdirSync, readFileSync, statSync, rmSync} from 'node:fs';
import {basename, join, relative} from 'node:path';
import type {Plugin} from 'vite';

/** Asset directories whose complete reference set can be derived from `src/data/*.json`. */
const PRUNABLE = ['flares/', 'icons/', 'land/', 'bg/'];

interface WeaponRow {
  icon?: string;
  expBitmap?: string;
  flareBmp?: string;
}
interface LandRow {
  bg?: string;
  layers?: {tile?: string}[];
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every asset path the game's DATA points at (weapon flares + arsenal icons, land backdrops/tiles). */
function dataReferenced(root: string): Set<string> {
  const read = <T>(p: string): T[] => JSON.parse(readFileSync(join(root, p), 'utf8')) as T[];
  const keep = new Set<string>();
  for (const w of read<WeaponRow>('src/data/weapons.json')) {
    if (w.expBitmap) keep.add(`flares/${w.expBitmap}`);
    if (w.flareBmp) keep.add(`flares/${w.flareBmp}`);
    // The arsenal renders each weapon at three sizes, keyed off the lower-cased icon name.
    if (w.icon) for (const s of [12, 16, 32]) keep.add(`icons/${s}x${s}/${w.icon.toLowerCase()}.bmp`);
  }
  for (const l of read<LandRow>('src/data/land.json')) {
    if (l.bg) keep.add(l.bg);
    for (const layer of l.layers ?? []) if (layer.tile) keep.add(layer.tile);
  }
  return keep;
}

/** True if `rel` (or its bare filename) is written out anywhere in the source tree. The filename
 *  form must be preceded by a slash or a quote, so `flares/10.bmp` is NOT kept alive by an
 *  unrelated `'gui/battle won 10.bmp'`. */
function mentionedInSource(corpus: string, rel: string): boolean {
  if (corpus.includes(rel)) return true;
  const name = basename(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`/]${name}`).test(corpus);
}

export function pruneDist(): Plugin {
  return {
    name: 'prune-dist',
    apply: 'build',
    closeBundle() {
      const root = process.cwd();
      const dist = join(root, 'dist');
      let distFiles: string[];
      try {
        distFiles = walk(dist);
      } catch {
        return; // no dist (e.g. a build that wrote nowhere) — nothing to do
      }

      // ── 1. Finder metadata: always removed ──────────────────────────────
      const junk = distFiles.filter(f => basename(f) === '.DS_Store');
      let junkBytes = 0;
      for (const f of junk) {
        junkBytes += statSync(f).size;
        rmSync(f);
      }
      if (junk.length) {
        this.info(`prune-dist: removed ${junk.length} .DS_Store (${(junkBytes / 1024).toFixed(0)} KB)`);
      }

      // ── 2. Unreferenced assets: reported, deleted only under PRUNE_ASSETS ─
      const assetDir = join(dist, 'assets');
      const keep = dataReferenced(root);
      const corpus = walk(join(root, 'src'))
        .filter(f => /\.(ts|tsx|css|json)$/.test(f))
        .map(f => readFileSync(f, 'utf8'))
        .join('\n');

      let candidates: string[];
      try {
        candidates = walk(assetDir)
          .map(f => relative(assetDir, f))
          .filter(rel => PRUNABLE.some(d => rel.startsWith(d)))
          .filter(rel => !keep.has(rel) && !mentionedInSource(corpus, rel))
          .sort();
      } catch {
        return; // no dist/assets — nothing further to check
      }

      // A data row naming an asset that isn't there is a 404 waiting to happen; surface it.
      for (const k of keep) {
        try {
          statSync(join(assetDir, k));
        } catch {
          this.warn(`prune-dist: ${k} is referenced by src/data but MISSING from the build`);
        }
      }

      if (!candidates.length) return;
      const bytes = candidates.reduce((a, rel) => a + statSync(join(assetDir, rel)).size, 0);
      const armed = process.env.PRUNE_ASSETS === '1';
      this.info(
        `prune-dist: ${candidates.length} unreferenced asset(s), ${(bytes / 1024).toFixed(0)} KB — ` +
          (armed ? 'deleting' : 'kept (set PRUNE_ASSETS=1 to delete)'),
      );
      for (const rel of candidates) this.info(`  ${armed ? '−' : '·'} assets/${rel}`);
      if (armed) for (const rel of candidates) rmSync(join(assetDir, rel));
    },
  };
}
