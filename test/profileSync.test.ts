/**
 * Profile sync, client side — drives the real `syncStore` against the real `Profile` Durable
 * Object over a stubbed `fetch`, so the compare-and-swap is exercised end to end rather than
 * against a hand-written fake of itself.
 *
 * A "device" here is a private localStorage map plus its own module instance of the store, and
 * `launch()` re-imports the module the way a page load re-seeds it. That is what lets one test
 * hold two devices at once — the scenario the whole design exists for.
 *
 * The `use()` calls before each action are load-bearing: the storage helpers resolve
 * `localStorage` at call time, so whichever device is "in front" has to be installed first.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {Profile} from '../worker/Profile';
import {newProfileCode} from '../src/net/profileCode';

// ==========================================================================
// HARNESS
// ==========================================================================

const JSON_H = {'content-type': 'application/json'};
/** Must match PUSH_DEBOUNCE_MS in syncStore; the auto-upload test advances past it. */
const DEBOUNCE_MS = 5_000;

type Store = Map<string, string>;

/** Point the global `localStorage` at one device's map. */
function installStorage(map: Store): void {
  const ls = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', {value: ls, configurable: true, writable: true});
}

/** A Profile DO over an in-memory store (mirrors test/profile.test.ts). */
function makeProfileDO() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Profile(ctx as any);
}

/** The Worker front door, reduced to the profile routes and backed by real DOs. */
function installServer() {
  const dos = new Map<string, Profile>();
  const stubFor = (code: string): Profile => {
    let d = dos.get(code);
    if (!d) {
      d = makeProfileDO();
      dos.set(code, d);
    }
    return d;
  };
  let offline = false;
  const server = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (offline) throw new TypeError('network down');
    const url = new URL(input, 'https://game.test');
    const method = init.method ?? 'GET';
    const body = init.body as string | undefined;
    if (url.pathname === '/api/profile') {
      const code = newProfileCode();
      const res = await stubFor(code).fetch(new Request('https://do/profile', {method: 'POST', headers: JSON_H, body}));
      if (!res.ok) return res;
      const out = (await res.json()) as {rev: number; updated: number};
      return new Response(JSON.stringify({code, ...out}), {status: 200, headers: JSON_H});
    }
    const code = url.pathname.slice('/api/profile/'.length);
    return stubFor(code).fetch(new Request('https://do/profile', {method, headers: JSON_H, body}));
  };
  vi.stubGlobal('fetch', server);
  return {
    setOffline: (v: boolean) => void (offline = v),
    /** What the server currently holds for `code` (null if nothing). */
    async data(code: string): Promise<Record<string, unknown> | null> {
      const res = await stubFor(code).fetch(new Request('https://do/profile', {method: 'GET'}));
      if (!res.ok) return null;
      return ((await res.json()) as {data: {data: Record<string, unknown>}}).data.data;
    },
    async rev(code: string): Promise<number> {
      const res = await stubFor(code).fetch(new Request('https://do/profile', {method: 'GET'}));
      return res.ok ? ((await res.json()) as {rev: number}).rev : 0;
    },
  };
}

type SyncModule = typeof import('../src/ui/syncStore');
type StorageModule = typeof import('../src/util/storage');

interface Device {
  map: Store;
  sync: SyncModule;
  storage: StorageModule;
}

/** Start (or restart) the game on a device: fresh module instances seeded from ITS storage,
 *  then the same boot sequence main.tsx runs — resolve against the cloud, then start watching. */
async function launch(map: Store = new Map()): Promise<Device> {
  installStorage(map);
  vi.resetModules();
  const sync = await import('../src/ui/syncStore');
  const storage = await import('../src/util/storage');
  await sync.bootSync();
  sync.initProfileSync();
  return {map, sync, storage};
}

/** Bring a device to the front before acting on it. */
const use = (dev: Device): Device => (installStorage(dev.map), dev);

/** Simulate the player changing something that a store persists. */
const change = (dev: Device, key: string, value: unknown): void => use(dev).storage.saveJSON(key, value);

const readLocal = (dev: Device, key: string): unknown => {
  const raw = dev.map.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
};

// ==========================================================================
// TESTS
// ==========================================================================

describe('profile sync', () => {
  let server: ReturnType<typeof installServer>;

  beforeEach(() => {
    vi.useFakeTimers();
    // initProfileSync registers exit-flush handlers; the headless harness has no real event
    // targets, so give it inert ones.
    const g = globalThis as Record<string, unknown>;
    g.addEventListener = () => {};
    (g.document as Record<string, unknown>).addEventListener = () => {};
    server = installServer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('creates a profile from this device and uploads later changes on its own', async () => {
    const a = await launch();
    change(a, 'atomic.heroes', ['ACE']);
    expect(await use(a).sync.createProfileNow()).toBe(true);
    const code = a.sync.syncLink.value.code;
    expect(code).toHaveLength(12);

    // The player changes something; nothing is sent until the debounce elapses.
    change(a, 'atomic.settings', {'gp.rounds': 12});
    expect(a.sync.syncLink.value.dirty).toBe(true);
    expect(await server.rev(code)).toBe(1);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(await server.rev(code)).toBe(2);
    expect(a.sync.syncLink.value.dirty).toBe(false);
    expect((await server.data(code))?.['atomic.settings']).toEqual({'gp.rounds': 12});
  });

  it('never uploads the sync link itself', async () => {
    const a = await launch();
    change(a, 'atomic.heroes', ['ACE']);
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;
    // Check an upload made AFTER linking, when the link key certainly exists on the device —
    // at create time it doesn't yet, so the create path alone would prove nothing.
    expect(a.map.has('atomic.sync')).toBe(true);
    change(a, 'atomic.settings', {'gp.rounds': 7});
    await use(a).sync.uploadNow();

    const stored = await server.data(code);
    // A profile carrying the link would make every device that restored it push as if it were
    // the SAME device — and the compare-and-swap would be guarding a revision it never read.
    expect(stored).not.toHaveProperty('atomic.sync');
    expect(stored?.['atomic.heroes']).toEqual(['ACE']);

    // It must also survive a round trip: loading the profile elsewhere must not overwrite that
    // device's own link (nor, on a fresh device, invent one).
    const b = await launch();
    await use(b).sync.linkProfile(code);
    expect(b.sync.syncLink.value.code).toBe(code);
    expect(readLocal(b, 'atomic.settings')).toEqual({'gp.rounds': 7});
  });

  it('a second device loads the profile and replaces its own data', async () => {
    const a = await launch();
    change(a, 'atomic.heroes', ['ACE']);
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;

    const b = await launch();
    change(b, 'atomic.heroes', ['NOBODY']);
    change(b, 'atomic.leftover', 'gone');
    expect(await use(b).sync.linkProfile(code)).toBe(true);

    expect(readLocal(b, 'atomic.heroes')).toEqual(['ACE']);
    // Replace, not merge: a key the profile doesn't carry must not survive the load.
    expect(readLocal(b, 'atomic.leftover')).toBeUndefined();
    expect(b.sync.syncLink.value.code).toBe(code);
  });

  it('two devices uploading concurrently: the second is REFUSED, not silently applied', async () => {
    const a = await launch();
    change(a, 'atomic.heroes', ['SHARED']);
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;

    const b = await launch();
    await use(b).sync.linkProfile(code);
    expect(b.sync.syncLink.value.rev).toBe(1);

    // Device A banks a score and publishes → rev 2.
    change(a, 'atomic.heroes', ['FROM_A']);
    await use(a).sync.uploadNow();
    expect(await server.rev(code)).toBe(2);

    // Device B, still holding rev 1, flushes its own snapshot. This is the exact moment A's
    // score would vanish under a last-write-wins store.
    change(b, 'atomic.heroes', ['FROM_B']);
    await use(b).sync.uploadNow();

    expect(b.sync.syncLink.value.stale).toBe(true);
    expect(b.sync.syncOutcome.value).toBe('conflict');
    expect(await server.rev(code)).toBe(2);
    expect((await server.data(code))?.['atomic.heroes']).toEqual(['FROM_A']);
  });

  it('a device that lost the race stops auto-uploading until it is relaunched', async () => {
    const a = await launch();
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;
    const b = await launch();
    await use(b).sync.linkProfile(code);

    change(a, 'atomic.heroes', ['FROM_A']);
    await use(a).sync.uploadNow();
    change(b, 'atomic.heroes', ['FROM_B']);
    await use(b).sync.uploadNow(); // → conflict, b is stale

    // Further local changes on B must not keep hammering the server with doomed writes.
    change(b, 'atomic.settings', {'gp.rounds': 3});
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(await server.rev(code)).toBe(2);
    expect((await server.data(code))?.['atomic.heroes']).toEqual(['FROM_A']);
  });

  it('relaunching a device that fell behind adopts the cloud copy (cloud wins)', async () => {
    const a = await launch();
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;
    const b = await launch();
    await use(b).sync.linkProfile(code);

    change(a, 'atomic.heroes', ['FROM_A']);
    await use(a).sync.uploadNow();
    change(b, 'atomic.heroes', ['FROM_B']);
    await use(b).sync.uploadNow(); // conflict

    // Restart B: boot resolution sees the cloud ahead and takes it, losing B's unsent changes —
    // the documented cost of cloud-wins, and the reason the conflict is surfaced in the UI.
    const b2 = await launch(b.map);
    expect(readLocal(b2, 'atomic.heroes')).toEqual(['FROM_A']);
    expect(b2.sync.syncLink.value.rev).toBe(2);
    expect(b2.sync.syncLink.value.stale).toBe(false);
    expect(b2.sync.syncLink.value.dirty).toBe(false);
  });

  it('boot publishes offline changes when nobody else wrote', async () => {
    const a = await launch();
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;

    // Go offline, change something, and close the game before it could be sent.
    server.setOffline(true);
    change(a, 'atomic.heroes', ['OFFLINE']);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    expect(a.sync.syncLink.value.dirty).toBe(true);

    // Next launch, back online: the revision still matches, so the pending changes go up.
    server.setOffline(false);
    const a2 = await launch(a.map);
    expect(a2.sync.syncLink.value.dirty).toBe(false);
    expect(await server.rev(code)).toBe(2);
    expect((await server.data(code))?.['atomic.heroes']).toEqual(['OFFLINE']);
  });

  it('booting with no connection leaves this device exactly as it was', async () => {
    const a = await launch();
    change(a, 'atomic.heroes', ['LOCAL']);
    await use(a).sync.createProfileNow();

    server.setOffline(true);
    const a2 = await launch(a.map);
    // Sync is a convenience: an unreachable server must never cost the player their data.
    expect(readLocal(a2, 'atomic.heroes')).toEqual(['LOCAL']);
    expect(a2.sync.syncLink.value.code).toBe(a.sync.syncLink.value.code);
  });

  it('a boot pull is not mistaken for a local edit', async () => {
    const a = await launch();
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;
    const b = await launch();
    await use(b).sync.linkProfile(code);

    change(a, 'atomic.heroes', ['FROM_A']);
    await use(a).sync.uploadNow(); // rev 2

    // B relaunches and pulls. Arming the change watcher before that pull would see its writes as
    // player edits and immediately push rev 3 — an upload of what was just downloaded.
    const b2 = await launch(b.map);
    expect(b2.sync.syncLink.value.dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(await server.rev(code)).toBe(2);
  });

  it('desync keeps both copies and stops uploading', async () => {
    const a = await launch();
    change(a, 'atomic.heroes', ['KEEP']);
    await use(a).sync.createProfileNow();
    const code = a.sync.syncLink.value.code;

    use(a).sync.desync();
    expect(a.sync.syncLink.value.code).toBe('');
    // Local data stays put...
    expect(readLocal(a, 'atomic.heroes')).toEqual(['KEEP']);
    // ...and so does the cloud copy, so the id can be linked again later.
    expect((await server.data(code))?.['atomic.heroes']).toEqual(['KEEP']);

    change(a, 'atomic.heroes', ['AFTER']);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect((await server.data(code))?.['atomic.heroes']).toEqual(['KEEP']);
  });

  it('reports a bad id and a missing profile differently', async () => {
    const a = await launch();
    expect(await use(a).sync.linkProfile('NOPE')).toBe(false);
    expect(a.sync.syncOutcome.value).toBe('badCode');

    // Well-formed but never created — the player mistyped a real-looking code.
    expect(await use(a).sync.linkProfile('ABCDEFGHJKMN')).toBe(false);
    expect(a.sync.syncOutcome.value).toBe('missing');
    expect(a.sync.syncLink.value.code).toBe('');
  });
});
