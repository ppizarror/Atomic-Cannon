/**
 * `extType` — a weapon's BEHAVIOUR-TYPE selector, the single authoritative source of
 * truth for what a weapon does. This module owns the value table ({@link EXT}), the
 * type derived from it ({@link ExtType}), and the narrowing that turns a raw JSON
 * number into that type ({@link toExtType}).
 *
 * `ExtType` is NOMINAL on purpose: it's an opaque token, NOT a plain `number`. So a bare
 * literal can never stand in for a behaviour selector — `ext === 1` is a COMPILE error
 * (`ext === EXT.DIGGER` is the only way to write it), which is what stops a value being
 * silently misrouted. The underlying runtime values are still the plain numbers 0..18
 * (the cast is type-only), so comparisons, `switch`, and the weapon JSON are unaffected.
 */

/**
 * The complete 0..18 behaviour map (no bare numbers anywhere) so a value can never be
 * silently misrouted — cross-checked against the weapon data and each type's weapons.
 * These are the raw codes; {@link EXT} exposes them as the nominal {@link ExtType} tokens.
 *
 * Two families:
 *  • PROJECTILE types fire a shot and are dispatched in `weaponFly`/`weaponDetonate`.
 *  • UTILITY types are on-use, NO projectile (heal/armour/shield/build/move) — applied
 *    when the weapon is used, handled outside the shot pipeline. Named here so they
 *    can't be missed.
 */
const EXT_CODES = {
  // -- projectile behaviours --
  BALLISTIC: 0, //  Shell / Bomb / Rocket / Dirt / Cleaner / NUKE / DOT / Organic / Missile (default)
  DIGGER: 1, //     Digger, Excavator — tunnels then detonates buried
  ROLLER: 2, //     Roller, Big Wheel, Mighty Roller — rolls downhill on contact
  MOVE: 3, //       Move Near / Mid / Far — relocate the firing tank
  TRACER: 4, //     Tracer 3/5 — plants a persistent aim marker on impact
  BEAM: 5, //       Magma / Blue / Wave / Grate Beam — instant ray, carves a slice
  BEAM_ALT: 6, //   (unused — no weapon carries it; kept so 6 is never treated as ballistic)
  SHIELD: 7, //     Light / Heavy Shield (utility)
  ESCAPE: 8, //     Escaper, Breakout — carves upward, keeps flying while rising
  REBOUND: 9, //    Rebounder, Seeker — bounces off / jets under the surface
  HEAL: 10, //      Repairs, Medkit, Medical Supply (utility)
  ARMOR: 11, //     Light / Heavy Armor (utility)
  DEATH: 12, //     Six Under, Burial Mound, Cremation, Ashes, Toxic Grave — drops on the firer
  AIRBURST: 13, //  Sky Bomb, Glowing Rain, Shrapnel, Sky Cluster — detonates at apex
  HAZMAT: 14, //    Light / Heavy Hazmat — sets piercing-resist (utility)
  BUNKER_WALL: 15, // Bunker, Wall — terrain tool: builds a flat-topped dirt platform (utility)
  MINE: 16, //      Mine, Minefield, Super Mine — plants a persistent mine
  JET: 17, //       Booster Jet, Jump Jet — tank flight (utility)
  SENTRY: 18, //    Sentry Turret, Sentry Minigun — deploys an auto-firing turret
} as const;

declare const EXT_BRAND: unique symbol;

/**
 * The authoritative behaviour selector — a nominal, opaque token, deliberately NOT a
 * `number`. A weapon's extType is exactly one of the {@link EXT} members; a bare literal
 * (`ext === 1`) does not type-check, so a selector can't be misrouted or invented.
 */
export type ExtType = {readonly [EXT_BRAND]: never};

/**
 * The behaviour selectors as nominal {@link ExtType} tokens — the ONLY way to name one.
 * Same keys/runtime values as the raw codes above; only the static type differs (the cast
 * is erased), so `EXT.DIGGER` is `1` at runtime but an `ExtType` to the type-checker.
 */
export const EXT = EXT_CODES as unknown as {readonly [K in keyof typeof EXT_CODES]: ExtType};

const EXT_VALUES: ReadonlySet<number> = new Set(Object.values(EXT_CODES));

/**
 * Narrow a raw `extType` (as it comes off the weapon JSON) to the authoritative
 * {@link ExtType} token. Any value not in {@link EXT} — including a missing/garbage
 * field — falls back to `BALLISTIC`, the plain-shot default.
 */
export function toExtType(n: number): ExtType {
  return (EXT_VALUES.has(n) ? n : EXT_CODES.BALLISTIC) as unknown as ExtType;
}
