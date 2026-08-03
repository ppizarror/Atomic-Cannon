/**
 * Profile — ONE Durable Object per profile id, holding that player's cloud save (the `atomic.`
 * localStorage snapshot: settings, controls, players, taunts, high scores). The id *is* the DO
 * name, so every device using a code reaches the same instance and reads its own writes.
 *
 * Writes are COMPARE-AND-SWAP, and that is the whole point of this class. Each write carries the
 * `rev` the client was working from; if the stored rev has moved on, the write is refused with
 * 409 instead of applied. Two devices that both auto-upload therefore cannot silently overwrite
 * each other — the second writer is told it lost and re-reads (see `src/net/profile.ts`). A
 * plain last-write-wins store would quietly drop whichever device flushed first.
 *
 * `blockConcurrencyWhile` serialises the read-modify-write so two requests arriving together
 * can't both observe the same rev and both be accepted.
 *
 * No accounts and no personal data: a profile is whatever the client chose to back up, reachable
 * only by knowing its 12-char id.
 */
import {type ProfileRecord, type ProfilePayload, PROFILE_MAX_BYTES, isPayload, payloadBytes} from '../src/net/profile';
import {json} from './http';

/** Sole storage key — the whole record is one value (a save is a few KB). */
const KEY = 'profile';

export class Profile {
  constructor(private readonly ctx: DurableObjectState) {}

  // ==========================================================================
  // REQUEST HANDLING
  // ==========================================================================

  async fetch(req: Request): Promise<Response> {
    if (req.method === 'GET') {
      const rec = await this.ctx.storage.get<ProfileRecord>(KEY);
      return rec ? json(rec) : json({error: 'no such profile'}, 404);
    }

    // POST = create (the mint path). PUT = update an existing profile.
    if (req.method !== 'POST' && req.method !== 'PUT') return json({error: 'method not allowed'}, 405);

    let body: {baseRev?: unknown; data?: unknown};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({error: 'bad body'}, 400);
    }
    if (!isPayload(body.data)) return json({error: 'bad payload'}, 400);
    const data: ProfilePayload = body.data;
    // Re-check the size here and not just at the front door: the cap is a storage invariant, so
    // it is enforced where the write actually happens.
    if (payloadBytes(data) > PROFILE_MAX_BYTES) return json({error: 'profile too large'}, 413);

    if (req.method === 'POST') return this.create(data);

    const baseRev = Number(body.baseRev);
    if (!Number.isFinite(baseRev)) return json({error: 'bad baseRev'}, 400);
    return this.update(baseRev, data);
  }

  // ==========================================================================
  // WRITES
  // ==========================================================================

  /** Claim this id for a brand-new profile. Refuses (409) if one already lives here, so the
   *  front door's re-roll on collision can never hand a player someone else's slot. */
  private async create(data: ProfilePayload): Promise<Response> {
    let taken = false;
    let rec: ProfileRecord | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<ProfileRecord>(KEY)) {
        taken = true;
        return;
      }
      rec = {rev: 1, updated: Date.now(), data};
      await this.ctx.storage.put(KEY, rec);
    });
    if (taken) return json({error: 'id already taken'}, 409);
    const created = rec as ProfileRecord | null;
    return json({rev: created?.rev ?? 1, updated: created?.updated ?? 0});
  }

  /** Compare-and-swap update. `baseRev` must equal the stored rev or the write is refused and
   *  the caller is told the current rev — it must re-read rather than retry with a higher rev,
   *  which would be exactly the blind overwrite this guards against. */
  private async update(baseRev: number, data: ProfilePayload): Promise<Response> {
    let result: {status: number; body: unknown} = {status: 500, body: {error: 'unreachable'}};
    await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<ProfileRecord>(KEY);
      // Nothing here: the id was never created (a typo) — creation goes through POST, so we do
      // NOT quietly conjure a profile from an update.
      if (!stored) {
        result = {status: 404, body: {error: 'no such profile'}};
        return;
      }
      if (stored.rev !== baseRev) {
        result = {status: 409, body: {error: 'stale revision', rev: stored.rev, updated: stored.updated}};
        return;
      }
      const next: ProfileRecord = {rev: stored.rev + 1, updated: Date.now(), data};
      await this.ctx.storage.put(KEY, next);
      result = {status: 200, body: {rev: next.rev, updated: next.updated}};
    });
    return json(result.body, result.status);
  }
}
