/**
 * The Profile Durable Object — the server half of cloud saves, driven against a mock
 * DurableObjectState (the same approach as roomAlarm.test.ts).
 *
 * The compare-and-swap cases are the point of this file: they are what stops two devices that
 * both auto-upload from silently overwriting each other, so a regression here would look like
 * "my high scores vanished" rather than like a crash.
 */
import {describe, it, expect} from 'vitest';
import {Profile} from '../worker/Profile';
import {PROFILE_MAX_BYTES} from '../src/net/profile';

/** A Profile DO over an in-memory store. `blockConcurrencyWhile` just runs the callback — the
 *  real one serialises, which is what makes the read-modify-write atomic in production. */
function makeProfile() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {profile: new Profile(ctx as any), stored: () => store.get('profile') as {rev: number; data: unknown}};
}

const req = (method: string, body?: unknown): Request =>
  new Request('https://do/profile', {
    method,
    headers: {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const backup = (extra: Record<string, unknown> = {}) => ({
  format: 'atomic-cannon-settings',
  version: 1,
  data: {'atomic.settings': {'gp.rounds': 12}, ...extra},
});

describe('Profile DO', () => {
  it('GET on an unused id is 404, not an empty profile', async () => {
    const {profile} = makeProfile();
    // A typo'd id must be distinguishable from a real but empty save, so the client can say
    // "check the code" instead of silently wiping the device with nothing.
    expect((await profile.fetch(req('GET'))).status).toBe(404);
  });

  it('POST creates at rev 1 and GET reads it back', async () => {
    const {profile} = makeProfile();
    const created = await profile.fetch(req('POST', {data: backup()}));
    expect(created.status).toBe(200);
    expect(((await created.json()) as {rev: number}).rev).toBe(1);

    const got = await profile.fetch(req('GET'));
    expect(got.status).toBe(200);
    const rec = (await got.json()) as {rev: number; data: unknown};
    expect(rec.rev).toBe(1);
    expect(rec.data).toEqual(backup());
  });

  it('POST refuses to overwrite an id that already holds a save', async () => {
    const {profile, stored} = makeProfile();
    await profile.fetch(req('POST', {data: backup()}));
    const second = await profile.fetch(req('POST', {data: backup({'atomic.heroes': ['intruder']})}));
    expect(second.status).toBe(409);
    // The original is untouched — this is what makes the mint re-roll safe.
    expect(stored().data).toEqual(backup());
  });

  it('PUT with the matching revision applies and bumps the rev', async () => {
    const {profile} = makeProfile();
    await profile.fetch(req('POST', {data: backup()}));
    const res = await profile.fetch(req('PUT', {baseRev: 1, data: backup({'atomic.heroes': ['ACE']})}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as {rev: number}).rev).toBe(2);
  });

  it('PUT with a stale revision is REFUSED and changes nothing', async () => {
    const {profile, stored} = makeProfile();
    await profile.fetch(req('POST', {data: backup()}));
    // Device A publishes; the profile moves to rev 2.
    await profile.fetch(req('PUT', {baseRev: 1, data: backup({'atomic.heroes': ['DEVICE_A']})}));

    // Device B still believes it holds rev 1 and flushes its own snapshot. Without the CAS this
    // is the moment device A's scores would disappear.
    const late = await profile.fetch(req('PUT', {baseRev: 1, data: backup({'atomic.heroes': ['DEVICE_B']})}));
    expect(late.status).toBe(409);
    expect(((await late.json()) as {rev: number}).rev).toBe(2); // tells B what it lost to

    expect(stored().rev).toBe(2);
    expect(stored().data).toEqual(backup({'atomic.heroes': ['DEVICE_A']}));
  });

  it('PUT against an id that was never created is 404, not a create', async () => {
    const {profile} = makeProfile();
    // Creation only happens through the mint path, which picks the id; an update must never
    // conjure a profile at an id the player typed wrong.
    expect((await profile.fetch(req('PUT', {baseRev: 0, data: backup()}))).status).toBe(404);
  });

  it('rejects a payload over the size cap', async () => {
    const {profile} = makeProfile();
    const huge = {format: 'atomic-cannon-settings', version: 1, data: {'atomic.x': 'y'.repeat(PROFILE_MAX_BYTES)}};
    expect((await profile.fetch(req('POST', {data: huge}))).status).toBe(413);
  });

  it('rejects bodies that are not a JSON object payload', async () => {
    const {profile} = makeProfile();
    expect((await profile.fetch(req('POST', {data: null}))).status).toBe(400);
    expect((await profile.fetch(req('POST', {data: [1, 2, 3]}))).status).toBe(400);
    expect((await profile.fetch(req('POST', {}))).status).toBe(400);
    // A non-numeric baseRev can't be compared, so it must not fall through to "matches".
    await profile.fetch(req('POST', {data: backup()}));
    expect((await profile.fetch(req('PUT', {baseRev: 'one', data: backup()}))).status).toBe(400);
  });

  it('rejects methods it does not implement', async () => {
    const {profile} = makeProfile();
    expect((await profile.fetch(req('DELETE'))).status).toBe(405);
  });
});
