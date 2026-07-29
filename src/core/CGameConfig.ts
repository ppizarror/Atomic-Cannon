/**
 * GameConfig — the live gameplay/graphics options read across the engine and renderers.
 *
 * A plain mutable singleton on purpose: these are global player preferences, not per-instance
 * state, and the read-sites (tank badge draw, shot launch, blast radius, render gates) are
 * scattered — threading them through every constructor and draw call would be pure noise.
 */

// Inert typed placeholders for the settings-mirror fields below. Their real value is written by
// ui/applySettings (applyGameConfig) at boot, before each game, and in the test setup — sourced
// entirely from ui/settingsCatalog. The literal here is NEVER read as a default (it's overwritten
// before anything reads it); it exists only to give the field a type. So a field's DEFAULT can
// only be changed in the catalog — there is no second value here to keep in sync. The `: type`
// annotations widen the literal (else `false`/`0` would narrow the field to a literal type).
const TYPE_BOOL: boolean = false;
const TYPE_INT: number = 0;
const TYPE_FLOAT: number = 0;

export const GameConfig = {
  // ── runtime state (NOT settings — no catalog entry; real values set during play) ──

  // World linear scale = worldWidth / viewWidth (= landSize, 1..5). Set at map load. The
  // original multiplies launch power AND gravity by the map scale so a full-power shot covers
  // the same fraction of the world at every map size; we apply √worldScale uniformly to the
  // physics (speed/gravity/wind/blast) — our world only widens (height is fixed), so a linear
  // scale would over-tall the arc; √ keeps range strong AND the arc on-screen.
  worldScale: 1,

  // Live view width in px (set at map load). Our world is sized in DISPLAY pixels, but the launch
  // SPEED was a fixed px/s — so a full-power shot's range (a fixed ~2000px) covered a shrinking
  // fraction of the world as the display widened (on an ultrawide it couldn't even cross the map).
  // `launchSpeed` scales by √(viewWidth / LAUNCH_REF_WIDTH) so max-power range is a consistent
  // multiple of the world width at every resolution. Default = the reference (no change when unset).
  viewWidth: 1000,

  // Whether a tank at 0 life is DESTROYED. Deathmatch = true (a killed tank explodes and drops
  // out); Rounds/Point = false — faithful to the original, where the per-hit dead-flag/explosion
  // lives entirely inside the Deathmatch branch, so a Rounds tank is never destroyed mid-game and
  // keeps taking turns (the round is scored by damage points, not eliminations). Set per match in
  // startGame from the game type; read by CTank.hit()/applyRadiationDamage.
  lethalDamage: true,

  // ── settings mirror ── these fields are OVERWRITTEN by ui/applySettings (applyGameConfig) from
  // settingsCatalog, the sole source of every default; the TYPE_* placeholders are inert (never read
  // as a default). Grouped and ordered to match the catalog (Economy · Tank · Gameplay · Graphics).

  // Economy
  buyTime: TYPE_INT, // Buy Time (0 Anytime · 1 After-round · 2 At-start · 3 Automatic)

  // Tank
  kickbackScale: TYPE_FLOAT, // Kickback (Off = 0)
  tankSizeScale: TYPE_FLOAT, // Player Size (hull + collision geometry)
  relativeTurrets: TYPE_BOOL, // Relative Turrets (aim relative to the tank's terrain tilt)
  buryTanks: TYPE_BOOL, // Bury Tanks (a tank can be trapped underground)
  powerScale: TYPE_FLOAT, // Power Scale (shot launch-speed)
  hitpoints: TYPE_INT, // Hitpoints (tank starting life)
  chatter: TYPE_BOOL, // Chatter ("Tanks talk to each other") — gates all taunt bubbles
  colorizeTeam: TYPE_BOOL, // Colorize Team (hull tint)

  // Gameplay
  // Land Size — world-width multiplier; 1..5 = "1 Screen / Small / Normal / Large / Massive" (1 = no scroll).
  landSize: TYPE_INT,
  changeWind: TYPE_INT, // Change Wind (0 Per-game · 1 After-round · 2 After-shot · 3 Anytime)
  windModel: TYPE_INT, // Wind Model (0 Linear/uniform · 1 Realistic boundary-layer profile). See core/wind.ts
  explosionScale: TYPE_FLOAT, // Explosion Size (blast radius)
  roundTime: TYPE_INT, // Round Timer — per-turn shot clock in seconds (0 = off → infinite turns)
  utilityTurn: TYPE_BOOL, // Utility Turn (using a utility ends the turn)
  randomizeTurns: TYPE_BOOL, // Randomize Turns (shuffle turn order each battle)
  randomizePosition: TYPE_BOOL, // Randomize Position (scatter squads across the map instead of grouping them)
  alternateTurns: TYPE_BOOL, // Alternate Turns (interleave teams: A1,B1,A2,B2 vs A1,A2,B1,B2)
  weaponPersist: TYPE_BOOL, // Weapon Persistence (the pick is the squad's, not the individual tank's)
  crateChance: TYPE_INT, // Crates: % chance to drop a supply crate each ROUND (0 = off)
  rightClickFires: TYPE_BOOL, // Right Click Fires (RMB launches the shot)
  radiationDamage: TYPE_BOOL, // A tank standing on the visible fallout carpet takes damage-over-time

  // Graphics
  tracking: TYPE_BOOL, // Tracking (off-screen shot notches)
  drawSmoke: TYPE_BOOL, // Draw Smoke (lingering ground plumes)
  detail: TYPE_INT, // Detail preset (0 Old School · 1 Simple · 2 High · 3 Wargame)
  craterFill: TYPE_BOOL, // Filled Craters (soil-filled crater interior vs transparent)
  highContrast: TYPE_BOOL, // High Contrast (white outline around tanks)
  showAiStats: TYPE_BOOL, // Show AI Stats (the active bot's aim solution)
  showTeamColor: TYPE_BOOL, // Show Team Color (name label)
  statusScroll: TYPE_BOOL, // Scroll Status List (window that follows the turn vs. the active row alone)
  smallBuyFonts: TYPE_BOOL, // Small Buy Fonts (compact depot list font)

  // Graphics — More Graphics Options
  showTurn: TYPE_BOOL, // Show Turn (turn arrow)
  blastCircles: TYPE_BOOL, // Show Blast Circles (ring at each explosion's radius)
  showPoints: TYPE_BOOL, // Show Points (floating damage number per hit)
  showPowerBars: TYPE_BOOL, // Show Power (life/shield bars)
  showTankStats: TYPE_BOOL, // Show Tank Stats (force always-on; default hover-only)
  autoScroll: TYPE_BOOL, // Auto Scroll (camera follows the shot / active tank)
  cameraMode: TYPE_INT, // Camera — turn hand-off: 0 Smooth · 1 Instant · 2 Cinematic (see CGameController CAM_*)
  showLastAim: TYPE_BOOL, // Show Last Aim (faded initial-aim marker)
  explosionWaves: TYPE_BOOL, // Explosion Waves (nuke refractive wave)
  cameraShake: TYPE_BOOL, // Camera Shake (screen shake on big/nuke blasts; port-only)
  explodeLosers: TYPE_BOOL, // Explode Losers (blow up the non-winning teams when a battle ends)
  demo: TYPE_BOOL, // Demo Mode (the human's turns are played by the AI)
  ambientLight: TYPE_BOOL, // Ambient Lighting (tint the scene toward the map's mood)
};

/** Detail preset values. */
export const DETAIL = {OLD_SCHOOL: 0, SIMPLE: 1, HIGH: 2, WARGAME: 3} as const;

/** Ground smoke draws only when Draw Smoke is on AND the Detail preset allows it — Old
 *  School and Wargame both force smoke off (matching the original's derived sub-flags). */
export function smokeEnabled(): boolean {
  return (
    GameConfig.drawSmoke &&
    GameConfig.detail !== DETAIL.OLD_SCHOOL &&
    GameConfig.detail !== DETAIL.WARGAME
  );
}

/** Wargame Detail preset — the tactical-map theme (silhouette tanks, "Whopper" bots, etc.). */
export function isWargame(): boolean {
  return GameConfig.detail === DETAIL.WARGAME;
}
