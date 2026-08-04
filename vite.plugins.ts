/**
 * This project's own Vite plugins: `pruneDist` (build) and `freePort` (dev server).
 */
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, statSync, rmSync} from 'node:fs';
import {basename, join, relative} from 'node:path';
import type {Plugin} from 'vite';

// ============================================================================
// freePort — dev server
// ============================================================================

/** How long to let a SIGTERM'd holder unbind before resorting to SIGKILL. */
const TERM_GRACE_MS = 1000;
const POLL_MS = 50;

/** Resolve as soon as `done()` holds, or once `timeoutMs` has passed — an unbind can only be
 *  polled for, there's nothing to await on. */
function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    if (done()) return resolve();
    let waited = 0;
    const timer = setInterval(() => {
      waited += POLL_MS;
      if (!done() && waited < timeoutMs) return;
      clearInterval(timer);
      resolve();
    }, POLL_MS);
  });
}

/** PIDs LISTENING on `port`, ourselves excluded. Empty when nothing holds it — and on any platform
 *  without `lsof` (it exits non-zero / isn't found, and either way there's nothing we can do). */
function listenersOn(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out.split('\n').map(Number);
    return [...new Set(pids.filter(pid => pid > 0 && pid !== process.pid && pid !== process.ppid))];
  } catch {
    return [];
  }
}

/** Executable name behind a pid, for the log line — the holder is not always a stale dev server. */
function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('/')
      .pop()!;
  } catch {
    return 'unknown';
  }
}

/**
 * Kill whatever is already listening on the dev-server port, before Vite tries to bind it.
 *
 * `server.strictPort` is deliberate — the dev URL, the Worker proxy targets and the browser probes
 * all assume :2141, so silently sliding to :2142 would be worse than failing. The cost is that one
 * `vite` orphaned by a closed terminal makes every later `pnpm dev` die with EADDRINUSE. So: SIGTERM
 * the holder, wait for it to unbind, SIGKILL anything still there. What was killed is always logged,
 * since the holder isn't guaranteed to be a stale dev server of ours.
 *
 * Runs from `configureServer`, which Vite awaits while creating the server — i.e. before `listen()`.
 */
export function freePort(): Plugin {
  let port: number | undefined;
  return {
    name: 'free-port',
    apply: 'serve',
    configResolved(config) {
      port = config.server.port;
    },
    async configureServer(server) {
      const log = server.config.logger;
      const p = port;
      if (p === undefined) return; // no fixed port — Vite will hunt for a free one itself
      const holders = listenersOn(p);
      if (!holders.length) return;

      for (const pid of holders) {
        try {
          process.kill(pid, 'SIGTERM');
          log.info(`free-port: :${p} was held by ${commandOf(pid)} (pid ${pid}) — terminated`);
        } catch (err) {
          // Gone between the lookup and the signal, or owned by another user: say so and let the
          // bind fail on its own terms rather than pretending the port is clear.
          log.warn(`free-port: could not signal pid ${pid} on :${p} — ${(err as Error).message}`);
        }
      }

      await waitFor(() => listenersOn(p).length === 0, TERM_GRACE_MS);
      for (const pid of listenersOn(p)) {
        try {
          process.kill(pid, 'SIGKILL');
          log.warn(`free-port: pid ${pid} ignored SIGTERM on :${p} — killed`);
        } catch {
          // Already dead; the port is free either way.
        }
      }
    },
  };
}

// ============================================================================
// pruneDist — build
// ============================================================================

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
