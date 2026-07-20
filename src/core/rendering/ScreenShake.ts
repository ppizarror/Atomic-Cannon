/**
 * ScreenShake — a decaying camera-shake offset (triggered by big detonations). Split
 * out of CParticleSystem, where it was an unrelated second exported class; it shares
 * none of the particle pools and is really a camera/view concern.
 */
import { plusMinus } from '../../math/random';

export class ScreenShake {
    private m_shakeIntensity = 0;
    private m_shakeDuration = 0;
    private m_startTime = 0;

    trigger(intensity: number, durationSec: number): void {
        this.m_shakeIntensity = intensity;
        this.m_shakeDuration = durationSec;
        this.m_startTime = performance.now() / 1000;
    }

    getOffset(): { x: number; y: number } {
        const elapsed = performance.now() / 1000 - this.m_startTime;
        if (elapsed > this.m_shakeDuration) return {x: 0, y: 0};
        const decay = 1 - elapsed / this.m_shakeDuration;
        const maxOffset = this.m_shakeIntensity * decay;
        return {x: plusMinus(maxOffset), y: plusMinus(maxOffset)};
    }

    isActive(): boolean {
        return performance.now() / 1000 - this.m_startTime < this.m_shakeDuration;
    }
}
