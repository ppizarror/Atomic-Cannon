/**
 * Wind model — the single source of truth for HOW wind strength varies with altitude,
 * shared by every wind-driven system (shots, aim AI, smoke/particles, weather, terrain
 * ejecta and victory fireworks) so the whole scene obeys one consistent air field.
 *
 * Two models, selectable in Settings → Gameplay → Wind Model:
 *
 *  • LINEAR (default) — wind is UNIFORM at every height (factor 1 everywhere). This is
 *    the classic Atomic Cannon feel and matches the original binary, which winds every
 *    projectile the same regardless of altitude.
 *
 *  • REALISTIC — an atmospheric BOUNDARY LAYER: friction with the soil slows the air near
 *    the surface, so wind is 0 at ground level and ramps up to full strength over the
 *    first `WIND_PROFILE_H` px above the terrain. Low-lying things (crater fumes, dirt
 *    settling near the ground, a shot skimming a hill) barely drift; high smoke, weather
 *    and the top of a tall arc get the full push.
 *
 * Both models expose the SAME multiplier API (`windProfile`), so a call site just
 * multiplies its wind acceleration by `windProfile(heightAboveGround)` and automatically
 * does the right thing in either mode — linear collapses the factor to a constant 1.
 */

import {GameConfig} from './CGameConfig';

/** Wind-model enum (Gameplay → Wind Model). Index matches the settings option list. */
export const WIND_MODEL = {LINEAR: 0, REALISTIC: 1} as const;

/**
 * Boundary-layer thickness in px. In the realistic model, wind rises linearly from 0 at
 * the surface to full strength at this height above it. ~260px ≈ a couple of tank-heights
 * of "slow air" hugging the ground, matching how blast fumes cling to a crater while high
 * smoke streams away.
 */
export const WIND_PROFILE_H = 260;

/** True when the realistic boundary-layer profile is active (else linear/uniform). */
export function isRealisticWind(): boolean {
  return GameConfig.windModel === WIND_MODEL.REALISTIC;
}

/**
 * The RAW boundary-layer factor (0..1): 0 at/below the surface, ramping to 1 at
 * `WIND_PROFILE_H` above it. Pass the height above ground (`groundY - y`).
 *
 * This is applied UNCONDITIONALLY — regardless of the Wind Model setting — by systems
 * where full wind right at the soil looks broken no matter what. In particular crater
 * SMOKE / fumes: a puff rising off the dirt must not instantly gain full horizontal wind
 * speed (it would rocket sideways off the ground). The near-ground easing is a rendering
 * necessity, not a gameplay choice, so it does NOT depend on Linear vs Realistic.
 */
export function boundaryFactor(above: number): number {
  if (above <= 0) return 0;
  if (above >= WIND_PROFILE_H) return 1;
  return above / WIND_PROFILE_H;
}

/**
 * Model-aware wind-strength multiplier (0..1) for the BALLISTIC systems the Wind Model
 * switch governs (shots, terrain ejecta, weather, and the aim AI that must match them):
 * Linear → always 1 (uniform wind at every height); Realistic → the `boundaryFactor`
 * ramp. Pass the height above ground (`groundY - y`).
 */
export function windProfile(above: number): number {
  return GameConfig.windModel === WIND_MODEL.REALISTIC ? boundaryFactor(above) : 1;
}

/**
 * Peak GUST as a fraction of the sustained wind (Realistic model): the along-wind strength
 * breathes ±`GUST_FRAC`, the vertical flutter half that. Multiplicative, so a Disabled wind (0)
 * stays dead calm.
 */
export const GUST_FRAC = 0.3;

/**
 * The multiplicative gust envelope at gust-clock time `t` (seconds) — the SAME breathing wind the
 * shots feel (`m_effWind = m_wind ⊙ gustFactor`) and the aim AI must predict so a skilled bot leads
 * the gust instead of aiming at the mean. Realistic model: a smooth multi-frequency ripple around 1
 * (superposed sines at incommensurate rates, so it never repeats). Linear model: a flat {1,1} (no
 * gusts), so every call site collapses to the sustained wind automatically. Deterministic in `t`,
 * so the trajectory is exactly predictable — that's what lets the bot solve it.
 */
export function gustFactor(t: number): {x: number; y: number} {
  if (GameConfig.windModel !== WIND_MODEL.REALISTIC) return {x: 1, y: 1};
  const gx =
    0.55 * Math.sin(t * 0.8) + 0.3 * Math.sin(t * 2.1 + 1.7) + 0.15 * Math.sin(t * 4.3 + 0.5);
  const gy = 0.6 * Math.sin(t * 1.3 + 2.0) + 0.4 * Math.sin(t * 3.1 + 0.8);
  return {x: 1 + gx * GUST_FRAC, y: 1 + gy * GUST_FRAC * 0.5};
}
