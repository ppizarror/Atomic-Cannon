/**
 * Shared plumbing for an enable-able, volume-controlled audio channel — the SFX bus and the
 * music bus each carried an identical copy: a gain node wired to a destination, an on/off
 * flag, and a 0..100 volume slider mapped onto the gain. Subclasses override `onDisable` to
 * stop whatever they're playing when the channel is muted.
 */
import {clamp} from '../math/num';

export abstract class GainChannel {
  protected readonly m_ctx: AudioContext;
  /** The channel's gain node — sources connect here; it feeds the `destination`. */
  protected readonly m_gain: GainNode;
  protected m_enabled = true;
  private m_volume = 100; // 0..100 (matches the options slider)

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.m_ctx = ctx;
    this.m_gain = ctx.createGain();
    this.m_gain.gain.value = this.m_volume / 100;
    this.m_gain.connect(destination);
  }

  setEnabled(on: boolean): void {
    this.m_enabled = on;
    if (!on) this.onDisable();
  }

  isEnabled(): boolean {
    return this.m_enabled;
  }

  /** Options-slider volume, 0..100. */
  setVolume(v: number): void {
    this.m_volume = clamp(v, 0, 100);
    this.m_gain.gain.value = this.m_volume / 100;
  }

  getVolume(): number {
    return this.m_volume;
  }

  /** Stop whatever's playing when the channel is disabled (no-op by default). */
  protected onDisable(): void {}
}
