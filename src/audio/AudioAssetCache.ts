/**
 * Fetch-once asset cache for the audio buses — the sound bank and the music player each carried
 * an identical copy: a resident map, an in-flight map so two concurrent requests for the same
 * file share ONE fetch, and a swallow-and-warn failure path (a missing asset must never break
 * gameplay). They differ only in what they decode a response into.
 *
 * Companion to {@link GainChannel}, which factored out the other half these two buses shared.
 */
export class AudioAssetCache<T> {
  private readonly m_ready = new Map<string, T>();
  private readonly m_loading = new Map<string, Promise<T | null>>();

  /**
   * @param m_base   URL prefix each name is resolved against.
   * @param m_decode turns a successful response into the cached value.
   * @param m_label  what to call the asset in the console warning on failure.
   */
  constructor(
    private readonly m_base: string,
    private readonly m_decode: (res: Response) => Promise<T>,
    private readonly m_label: string,
  ) {}

  /** The resident value, or undefined if it hasn't finished loading. The synchronous fast path
   *  for callers that can act immediately when the asset is already in memory. */
  peek(name: string): T | undefined {
    return this.m_ready.get(name);
  }

  /** Resident value, the in-flight request, or a fresh fetch. Never rejects — a failed load
   *  resolves to null so a missing asset degrades to silence instead of an unhandled rejection. */
  load(name: string): Promise<T | null> {
    const cached = this.m_ready.get(name);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.m_loading.get(name);
    if (inFlight) return inFlight; // a concurrent request for the same asset shares one fetch

    const job = (async () => {
      try {
        const res = await fetch(encodeURI(this.m_base + name));
        if (!res.ok) throw new Error(`${res.status}`);
        const value = await this.m_decode(res);
        this.m_ready.set(name, value);
        return value;
      } catch (e) {
        console.warn(`${this.m_label} load failed: ${name}`, e);
        return null;
      } finally {
        this.m_loading.delete(name);
      }
    })();
    this.m_loading.set(name, job);
    return job;
  }
}
