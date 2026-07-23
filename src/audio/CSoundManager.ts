/**
 * CSoundManager — Web Audio sound-effects engine.
 *
 * Routes every effect through a single `play(name)` funnel backed by a
 * name-keyed sample cache. Details:
 *
 *  - Sounds are keyed by their **filename** ("cannon.wav", "hit high.wav"), not a
 *    numeric enum — exactly how the weapon `soundFire`/`soundHit` strings map.
 *  - A per-name **retrigger throttle** stops the same effect from
 *    machine-gunning every frame.
 *  - Per-shot **stereo pan** from the source's world-X, and a master SFX
 *    **gain** (vol/100).
 *  - Looping named sounds (`tank moving.wav`, `jet.wav`) start/stop by name,
 *    driven by the movement state machine.
 */

import {GainChannel} from './GainChannel';

const SOUND_BASE = '/assets/sound/';

// Minimum gap before the same-named effect may retrigger. ~45ms ≈ 3 frames at
// 60fps: enough to stop per-frame spam without swallowing distinct rapid shots.
const RETRIGGER_MS = 45;

interface LoopHandle {
  src: AudioBufferSourceNode;
  panner: StereoPannerNode;
  gain: GainNode;
}

export class CSoundManager extends GainChannel {
  private m_buffers = new Map<string, AudioBuffer>();
  private m_loading = new Map<string, Promise<AudioBuffer | null>>();
  private m_lastPlay = new Map<string, number>(); // throttle timestamps (ms)
  private m_loops = new Map<string, LoopHandle>(); // named looping sounds
  private m_worldWidth = 1; // for world-X → pan

  constructor(ctx: AudioContext, destination: AudioNode) {
    super(ctx, destination);
  }

  /** World width in pixels — the pan axis. Set once the scene size is known. */
  setWorldWidth(w: number): void {
    this.m_worldWidth = Math.max(1, w);
  }

  /** Disabling the SFX channel also cuts any looping sounds (movement / jet). */
  protected onDisable(): void {
    this.stopAllLoops();
  }

  /**
   * Preload a set of effects (a menu set and a combat set).
   * Failures are swallowed — a missing effect must never break gameplay.
   */
  async preload(names: Iterable<string>): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const name of names) if (name) jobs.push(this.loadBuffer(name));
    await Promise.all(jobs);
  }

  private loadBuffer(name: string): Promise<AudioBuffer | null> {
    const cached = this.m_buffers.get(name);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.m_loading.get(name);
    if (inFlight) return inFlight;

    const job = (async () => {
      try {
        const res = await fetch(encodeURI(SOUND_BASE + name));
        if (!res.ok) throw new Error(`${res.status}`);
        const buf = await this.m_ctx.decodeAudioData(await res.arrayBuffer());
        this.m_buffers.set(name, buf);
        return buf;
      } catch (e) {
        console.warn(`sound load failed: ${name}`, e);
        return null;
      } finally {
        this.m_loading.delete(name);
      }
    })();
    this.m_loading.set(name, job);
    return job;
  }

  /** world-X → stereo pan in [-1, 1]. Centre-screen = 0. */
  private panFor(worldX: number | undefined): number {
    if (worldX === undefined) return 0;
    return Math.max(-1, Math.min(1, (worldX / this.m_worldWidth) * 2 - 1));
  }

  /**
   * Play a one-shot effect by filename, panned to `worldX`. Loads on demand.
   * `opts.throttle=false` bypasses the retrigger guard (for deliberately layered
   * simultaneous shots); `opts.volume` (0..1) attenuates this instance.
   */
  play(name: string, worldX?: number, opts: {throttle?: boolean; volume?: number} = {}): void {
    if (!this.m_enabled || !name) return;

    if (opts.throttle !== false) {
      const now = this.now();
      const last = this.m_lastPlay.get(name) ?? -Infinity;
      if (now - last < RETRIGGER_MS) return;
      this.m_lastPlay.set(name, now);
    }

    const buf = this.m_buffers.get(name);
    if (buf) {
      this.spawn(buf, this.panFor(worldX), opts.volume ?? 1);
      return;
    }
    // Not resident yet — load then play (skips if it turns out to be missing).
    this.loadBuffer(name).then(b => {
      if (b) this.spawn(b, this.panFor(worldX), opts.volume ?? 1);
    });
  }

  private spawn(buf: AudioBuffer, pan: number, volume: number): void {
    const src = this.m_ctx.createBufferSource();
    src.buffer = buf;
    const panner = this.m_ctx.createStereoPanner();
    panner.pan.value = pan;
    let tail: AudioNode = panner;
    if (volume !== 1) {
      const g = this.m_ctx.createGain();
      g.gain.value = volume;
      panner.connect(g);
      tail = g;
    }
    src.connect(panner);
    tail.connect(this.m_gain);
    src.start();
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  // ── Looping named sounds (tank moving / jet) ───────────────────────────────

  /** Start (or keep) a looping sound keyed by name. Idempotent — a second call
   *  while it's already playing just repans it (the movement dedup check:
   *  "is this named sound already playing?"). */
  startLoop(name: string, worldX?: number): void {
    if (!this.m_enabled || !name) return;
    const existing = this.m_loops.get(name);
    if (existing) {
      existing.panner.pan.value = this.panFor(worldX);
      return;
    }

    const buf = this.m_buffers.get(name);
    if (!buf) {
      this.loadBuffer(name).then(b => {
        if (b && !this.m_loops.has(name)) this.beginLoop(name, b, worldX);
      });
      return;
    }
    this.beginLoop(name, buf, worldX);
  }

  private beginLoop(name: string, buf: AudioBuffer, worldX?: number): void {
    const src = this.m_ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const panner = this.m_ctx.createStereoPanner();
    panner.pan.value = this.panFor(worldX);
    const gain = this.m_ctx.createGain();
    src.connect(panner);
    panner.connect(gain);
    gain.connect(this.m_gain);
    src.start();
    this.m_loops.set(name, {src, panner, gain});
  }

  /** Update the pan of an active loop as the source moves across the field. */
  setLoopPan(name: string, worldX: number): void {
    const h = this.m_loops.get(name);
    if (h) h.panner.pan.value = this.panFor(worldX);
  }

  /** Stop a named loop (the movement machine's stop-named-sound). */
  stopLoop(name: string): void {
    const h = this.m_loops.get(name);
    if (!h) return;
    try {
      h.src.stop();
      h.src.disconnect();
    } catch {
      /* already stopped */
    }
    this.m_loops.delete(name);
  }

  stopAllLoops(): void {
    // Snapshot the keys first — stopLoop() deletes from m_loops as we go.
    for (const name of Array.from(this.m_loops.keys())) this.stopLoop(name);
  }

  private now(): number {
    // ctx time is monotonic and unaffected by tab throttling drift.
    return this.m_ctx.currentTime * 1000;
  }
}
