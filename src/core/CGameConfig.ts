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
  // ── world / camera ──
  // Land Size (Settings → Gameplay). World width = viewWidth × scale; scale is
  // 1..5 for "1 Screen / Small / Normal / Large / Massive" (1 = no scroll).
  landSize: 3,
  autoScroll: true, // More Graphics Options → Auto Scroll (camera follows the shot / active tank)

  // World linear scale = worldWidth / viewWidth (= landSize, 1..5). Set at map load. The
  // original multiplies launch power AND gravity by the map scale so a full-power shot covers
  // the same fraction of the world at every map size; we apply √worldScale uniformly to the
  // physics (speed/gravity/wind/blast) — our world only widens (height is fixed), so a linear
  // scale would over-tall the arc; √ keeps range strong AND the arc on-screen.
  worldScale: 1,

  // ── physics / gameplay scalars (1 = the default feel) ──
  kickbackScale: 1, // Tank → Kickback (Off = 0)
  explosionScale: 1, // Gameplay → Explosion Size
  powerScale: 1, // Tank → Power Scale
  tankSizeScale: 1, // Tank → Player Size (hull + collision geometry)
  hitpoints: 1000, // Tank → Hitpoints (tank starting life)

  // ── render toggles ──
  drawSmoke: true, // Graphics → Draw Smoke (lingering ground plumes)
  colorizeTeam: true, // Tank → Colorize Team (hull tint)
  chatter: true, // Tank → Chatter ("Tanks talk to each other") — gates all taunt bubbles
  crateChance: 20, // Gameplay → Crates: % chance to drop a supply crate each turn (0 = off)
  showTeamColor: true, // Graphics → Show Team Color (name label)
  showPowerBars: true, // Graphics → Show Power (life/shield bars)
  showTankStats: false, // More Graphics Options → Show Tank Stats (force always-on; default hover-only)
  tracking: true, // Graphics → Tracking (off-screen shot notches)
  showPoints: true, // More Graphics Options → Show Points (floating damage number per hit)
  showTurn: true, // More Graphics Options → Show Turn (turn arrow)
  showLastAim: true, // More Graphics Options → Show Last Aim (faded initial-aim marker)
  explosionWaves: true, // More Graphics Options → Explosion Waves (nuke refractive wave)
  cameraShake: true, // More Graphics Options → Camera Shake (screen shake on big/nuke blasts; port-only)
  blastCircles: false, // More Graphics Options → Show Blast Circles (ring at each explosion's radius)
  highContrast: false, // Graphics → High Contrast (white outline around tanks)
  showAiStats: false, // Graphics → Show AI Stats (the active bot's aim solution)
  demo: false, // More Graphics Options → Demo Mode (the human's turns are played by the AI)
};
