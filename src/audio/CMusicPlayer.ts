/**
 * CMusicPlayer — Impulse Tracker (.it) module playback via libopenmpt (WASM).
 *
 * The game's 6 `.it` modules are tracker modules, not PCM. Browsers can't play
 * `.it` natively, so we drive libopenmpt compiled to WebAssembly inside an
 * AudioWorklet (the vendored chiptune3 worklet under /audio/). This gives
 * true tracker playback of the module files rather than a pre-rendered
 * approximation.
 *
 * Track-selection policy (see CAudio):
 *   menu   → "Four Ages.it" looped
 *   battle → ONE random pick of 3 tracks, looped
 *   win    → "Airborne.it" once;  lose → "Well.it" once
 *
 * Message protocol matches the vendored worklet (registerProcessor
 * 'libopenmpt-processor'): post {cmd:'config'|'play'|'stop'|'repeatCount'};
 * receive {cmd:'meta'|'end'|'err'}.
 */

import {GainChannel} from './GainChannel';

const MUSIC_BASE = '/assets/music/';
const WORKLET_URL = '/audio/chiptune3.worklet.js';

// libopenmpt repeatCount: -1 = loop forever, 0 = play once.
const LOOP_FOREVER = -1;
const PLAY_ONCE = 0;

// Music makeup gain. libopenmpt renders these .it modules with a lot of headroom:
// measured across all 6 tracks, mean levels sit near -33 dBFS and the LOUDEST peak
// (Four Ages, the menu bed) is only -13.9 dBFS — roughly 20 dB below the WAV SFX,
// which peak near 0 dB. At unity bus gain the music was drowned out (most audible on
// the menu, where no SFX mask it). x4 (~+12 dB) lifts the loudest module's peak to
// ~-1.9 dB — a big loudness gain with headroom to spare against clipping.
const MUSIC_MAKEUP = 4.0;

export class CMusicPlayer extends GainChannel {
  private m_node: AudioWorkletNode | null = null;
  private m_ready: Promise<void>;
  private m_current: string | null = null; // filename currently requested
  private m_loop = false; // whether the current track loops
  private m_onEnded: (() => void) | null = null;
  private m_buffers = new Map<string, ArrayBuffer>();
  private m_loading = new Map<string, Promise<ArrayBuffer | null>>(); // in-flight fetch dedup

  constructor(ctx: AudioContext, destination: AudioNode) {
    super(ctx, destination);
    this.m_ready = this.initNode();
  }

  private async initNode(): Promise<void> {
    try {
      await this.m_ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(this.m_ctx, 'libopenmpt-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e: MessageEvent) => this.onWorkletMessage(e.data);
      node.port.postMessage({
        cmd: 'config',
        val: {
          repeatCount: LOOP_FOREVER,
          stereoSeparation: 100,
          interpolationFilter: 0,
        },
      });
      // Makeup gain to compensate libopenmpt's conservative render level (see MUSIC_MAKEUP),
      // sitting before the channel's volume gain so the options slider still scales it.
      const makeup = this.m_ctx.createGain();
      makeup.gain.value = MUSIC_MAKEUP;
      node.connect(makeup);
      makeup.connect(this.m_gain);
      this.m_node = node;
    } catch (e) {
      console.warn('music worklet init failed — music disabled', e);
    }
  }

  private onWorkletMessage(msg: {cmd: string; val?: unknown}): void {
    if (msg.cmd === 'end') this.m_onEnded?.();
    else if (msg.cmd === 'err') console.warn('libopenmpt error:', msg.val);
  }

  /** Disabling the music channel stops the current track. */
  protected onDisable(): void {
    this.stop();
  }

  /** Fires when a non-looping track finishes (win/lose jingles). */
  onEnded(cb: () => void): void {
    this.m_onEnded = cb;
  }

  currentTrack(): string | null {
    return this.m_current;
  }

  /**
   * Play a module by filename. `loop` true = battle/menu bed; false = one-shot
   * jingle. No-op (but remembered) if the same looping track is already playing.
   */
  async play(file: string, loop: boolean): Promise<void> {
    if (!this.m_enabled || !file) return;
    if (loop && this.m_current === file) return; // already looping this bed
    this.m_current = file;
    this.m_loop = loop;

    await this.m_ready;
    if (!this.m_node) return;

    const data = await this.fetchModule(file);
    if (!data || this.m_current !== file) return; // superseded while loading

    this.m_node.port.postMessage({cmd: 'repeatCount', val: loop ? LOOP_FOREVER : PLAY_ONCE});
    // The worklet takes ownership of the buffer; hand it a copy so our cache stays intact.
    this.m_node.port.postMessage({cmd: 'play', val: data.slice(0)});
  }

  /**
   * Re-post the current track. Used after the AudioContext is unlocked: a track
   * requested while the context was still suspended (e.g. menu music at boot)
   * doesn't reliably auto-start on resume, so we replay it on a live context.
   */
  replay(): void {
    const file = this.m_current;
    if (!file) return;
    this.m_current = null; // bypass the "already playing" guard
    void this.play(file, this.m_loop);
  }

  stop(): void {
    this.m_current = null;
    this.m_node?.port.postMessage({cmd: 'stop'});
  }

  private fetchModule(file: string): Promise<ArrayBuffer | null> {
    const cached = this.m_buffers.get(file);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.m_loading.get(file);
    if (inFlight) return inFlight; // a concurrent play() of the same track shares one fetch
    const job = (async () => {
      try {
        const res = await fetch(encodeURI(MUSIC_BASE + file));
        if (!res.ok) throw new Error(`${res.status}`);
        const buf = await res.arrayBuffer();
        this.m_buffers.set(file, buf);
        return buf;
      } catch (e) {
        console.warn(`music load failed: ${file}`, e);
        return null;
      } finally {
        this.m_loading.delete(file);
      }
    })();
    this.m_loading.set(file, job);
    return job;
  }
}
