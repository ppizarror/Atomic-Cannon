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

  // Live view width in px (set at map load). Our world is sized in DISPLAY pixels, but the launch
  // SPEED was a fixed px/s — so a full-power shot's range (a fixed ~2000px) covered a shrinking
  // fraction of the world as the display widened (on an ultrawide it couldn't even cross the map).
  // `launchSpeed` scales by √(viewWidth / LAUNCH_REF_WIDTH) so max-power range is a consistent
  // multiple of the world width at every resolution. Default = the reference (no change when unset).
  viewWidth: 1000,

  // (Blast SIZE scale is a DERIVED render value — `CGameController.blastScale`, off the live canvas —
  // NOT a setting, so it does not live here. `worldScale` below IS kept here: shot PHYSICS read it.)

  // ── physics / gameplay scalars (1 = the default feel) ──
  kickbackScale: 1, // Tank → Kickback (Off = 0)
  explosionScale: 1, // Gameplay → Explosion Size
  powerScale: 1, // Tank → Power Scale
  tankSizeScale: 1, // Tank → Player Size (hull + collision geometry)
  hitpoints: 1000, // Tank → Hitpoints (tank starting life)

  // Gameplay → Radiation Damage. ON (default, port interpretation): a tank standing on the visible
  // fallout carpet takes damage-over-time — "green ground = danger", so the damage matches what the
  // player sees. OFF (legacy/faithful): fallout is purely cosmetic and deals NO tank damage, exactly
  // like the original binary (a radioactive weapon's INITIAL blast is armor-piercing either way).
  // A gameplay rule → shared over the network via MatchConfig so every client simulates the same.
  radiationDamage: true,

  // Whether a tank at 0 life is DESTROYED. Deathmatch = true (a killed tank explodes and drops
  // out); Rounds/Point = false — faithful to the original, where the per-hit dead-flag/explosion
  // lives entirely inside the Deathmatch branch, so a Rounds tank is never destroyed mid-game and
  // keeps taking turns (the round is scored by damage points, not eliminations). Set per match in
  // startGame from the game type; read by CTank.hit()/applyRadiationDamage.
  lethalDamage: true,

  // ── render toggles ──
  drawSmoke: true, // Graphics → Draw Smoke (lingering ground plumes)
  colorizeTeam: true, // Tank → Colorize Team (hull tint)
  chatter: true, // Tank → Chatter ("Tanks talk to each other") — gates all taunt bubbles
  crateChance: 20, // Gameplay → Crates: % chance to drop a supply crate each ROUND (0 = off)
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
  explodeLosers: true, // Graphics → Explode Losers (blow up the non-winning teams when a battle ends)
  showAiStats: false, // Graphics → Show AI Stats (the active bot's aim solution)
  demo: false, // More Graphics Options → Demo Mode (the human's turns are played by the AI)
  ambientLight: true, // More Graphics Options → Ambient Lighting (tint the scene toward the map's mood)

  // ── formerly-unwired options (Settings parity) ──
  rightClickFires: true, // Gameplay → Right Click Fires (RMB launches the shot)
  smallBuyFonts: false, // Graphics → Small Buy Fonts (compact depot list font)
  relativeTurrets: false, // Tank → Relative Turrets (aim relative to the tank's terrain tilt)
  buryTanks: false, // Tank → Bury Tanks (a tank can be trapped underground)
  utilityTurn: false, // Gameplay → Utility Turn (using a utility ends the turn)
  randomizeTurns: false, // Gameplay → Randomize Turns (shuffle turn order each battle)
  alternateTurns: false, // Gameplay → Alternate Turns (interleave teams: A1,B1,A2,B2 vs A1,A2,B1,B2)
  buyTime: 0, // Economy → Buy Time (0 Anytime · 1 After-round · 2 At-start · 3 Automatic)
  changeWind: 0, // Gameplay → Change Wind (0 Per-game · 1 After-round · 2 After-shot · 3 Anytime)
  windModel: 0, // Gameplay → Wind Model (0 Linear/uniform · 1 Realistic boundary-layer profile). See core/wind.ts

  detail: 2, // Graphics → Detail preset (0 Old School · 1 Simple · 2 High · 3 Wargame)
  craterFill: false, // Graphics → Filled Craters (soil-filled crater interior vs transparent)
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
