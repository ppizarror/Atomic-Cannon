/**
 * GameConfig — live gameplay/graphics options set from the Settings menu (written by
 * ui/applySettings) and read across the engine and renderers.
 *
 * A plain mutable singleton on purpose: these are global player preferences, not
 * per-instance state, and the read-sites (tank badge draw, shot launch, blast radius,
 * render gates) are scattered — threading them through every constructor and draw
 * call would be pure noise. Defaults reproduce the baseline hard-coded behaviour
 * (scalars = 1, every display toggle on), so an unconfigured build looks unchanged.
 */
export const GameConfig = {
  // ── physics / gameplay scalars (1 = the default feel) ──
  kickbackScale: 1,      // Tank → Kickback (Off = 0)
  explosionScale: 1,     // Gameplay → Explosion Size
  powerScale: 1,         // Tank → Power Scale
  hitpoints: 1000,       // Tank → Hitpoints (tank starting life)

  // ── render toggles ──
  colorizeTeam: true,    // Tank → Colorize Team (hull tint)
  showTeamColor: true,   // Graphics → Show Team Color (name label)
  showPowerBars: true,   // Graphics → Show Power (life/shield bars)
  showTankStats: false,  // Graphics 2 → Show Tank Stats (force always-on; default hover-only)
  tracking: true,        // Graphics → Tracking (off-screen shot notches)
  showTurn: true,        // Graphics 2 → Show Turn (turn arrow)
  showLastAim: true,     // Graphics 2 → Show Last Aim (faded initial-aim marker)
  explosionWaves: true,  // Graphics 2 → Explosion Waves (nuke refractive wave)
};
