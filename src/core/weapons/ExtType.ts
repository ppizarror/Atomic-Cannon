/**
 * `extType` — a weapon's BEHAVIOUR-TYPE selector, the single authoritative source of
 * truth for what a weapon does. This module owns the value table ({@link EXT}), the
 * type derived from it ({@link ExtType}), and the narrowing that turns a raw JSON
 * number into that type ({@link toExtType}).
 *
 * `ExtType` is NOMINAL on purpose: it's an opaque token, NOT a plain `number`. So a bare
 * literal can never stand in for a behaviour selector — `ext === 1` is a COMPILE error
 * (`ext === EXT.DIGGER` is the only way to write it), which is what stops a value being
 * silently misrouted. The underlying runtime values are still the plain numbers 0..19
 * (the cast is type-only), so comparisons, `switch`, and the weapon JSON are unaffected.
 */
import {makeNominalEnum} from './nominalEnum';

/**
 * The complete 0..19 behaviour map (no bare numbers anywhere) so a value can never be
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
  // ---- PROJECTILE BEHAVIOURS ---------------------------------------------
  BALLISTIC: 0, //    Shell / Bomb / Rocket / Dirt / Cleaner / NUKE / DOT / Organic / Missile (default)
  DIGGER: 1, //       Digger, Excavator — tunnels then detonates buried
  ROLLER: 2, //       Roller, Big Wheel, Mighty Roller — rolls downhill on contact
  MOVE: 3, //         Move Near / Mid / Far — relocate the firing tank
  TRACER: 4, //       Tracer 3/5 — plants a persistent aim marker on impact
  BEAM: 5, //         Magma / Blue / Wave / Grate Beam — instant ray, carves a slice
  BEAM_ALT: 6, //     (unused — no weapon carries it; kept so 6 is never treated as ballistic)
  SHIELD: 7, //       Light / Heavy Shield (utility)
  ESCAPE: 8, //       Escaper, Breakout — carves upward, keeps flying while rising
  REBOUND: 9, //      Rebounder, Seeker — bounces off / jets under the surface
  HEAL: 10, //        Repairs, Medkit, Medical Supply (utility)
  ARMOR: 11, //       Light / Heavy Armor (utility)
  DEATH: 12, //       Six Under, Burial Mound, Cremation, Ashes, Toxic Grave — drops on the firer
  AIRBURST: 13, //    Sky Bomb, Glowing Rain, Shrapnel, Sky Cluster — detonates at apex
  HAZMAT: 14, //      Light / Heavy Hazmat — sets piercing-resist (utility)
  BUNKER_WALL: 15, // Bunker, Wall — terrain tool: builds a flat-topped dirt platform (utility)
  MINE: 16, //        Mine, Minefield, Super Mine — plants a persistent mine
  JET: 17, //         Booster Jet, Jump Jet — tank flight (utility)
  SENTRY: 18, //      Sentry Turret, Sentry Minigun — deploys an auto-firing turret
  HOMING: 19, //      Homing Missile — at apex, bends its arc toward a tank near where it would land
} as const;

declare const EXT_BRAND: unique symbol;

/**
 * The authoritative behaviour selector — a nominal, opaque token, deliberately NOT a
 * `number`. A weapon's extType is exactly one of the {@link EXT} members; a bare literal
 * (`ext === 1`) does not type-check, so a selector can't be misrouted or invented.
 */
export type ExtType = {readonly [EXT_BRAND]: never};

/**
 * The behaviour selectors as nominal {@link ExtType} tokens (`EXT.DIGGER` is `1` at runtime
 * but an `ExtType` to the checker) plus {@link toExtType}, which narrows a raw JSON number to
 * the token — any value not in the table (missing / garbage) falls back to `BALLISTIC`. The
 * nominal-enum boilerplate is shared via {@link makeNominalEnum}; only the brand + fallback
 * differ per module, so `ExtType` stays a DISTINCT type from `ExpType`.
 */
export const {tokens: EXT, toType: toExtType} = makeNominalEnum<ExtType, typeof EXT_CODES>(EXT_CODES, 'BALLISTIC');

/**
 * The SAME table as {@link EXT}, typed as plain numbers.
 *
 * The nominal token is the right thing wherever a weapon has been resolved through `CWeapon`, but
 * the bot brains and the economy work off the weapon data's raw `extType` field (and `UltraWeapon.ext`
 * carries it as a number), where a token would only have to be cast back. They read the codes from
 * here so the numbers live in exactly one place — three separate hand-written copies of this table
 * had accumulated across CBotAI / CEconomy / botEconomy.
 */
export const EXT_CODE: {readonly [K in keyof typeof EXT_CODES]: number} = EXT_CODES;

/**
 * UTILITY/support extTypes — everything that is not offensive ammo: relocation, ranging, the
 * self-buffs, mines and jets. Auto Buy never stocks them, the classic brain never draws one as its
 * random offensive pick, and Ultra excludes them from its firing pool. One set, because all three
 * rules mean the same thing by it.
 */
export const UTILITY_EXT: ReadonlySet<number> = new Set<number>([
  EXT_CODE.MOVE,
  EXT_CODE.TRACER,
  EXT_CODE.SHIELD,
  EXT_CODE.HEAL,
  EXT_CODE.ARMOR,
  EXT_CODE.DEATH,
  EXT_CODE.HAZMAT,
  EXT_CODE.MINE,
  EXT_CODE.JET,
]);

/** Beam-family behaviour (an instant carving ray) — BEAM or the reserved BEAM_ALT. */
export const isBeamExt = (ext: ExtType): boolean => ext === EXT.BEAM || ext === EXT.BEAM_ALT;

/** A utility a tank applies to ITSELF (shield / heal / armor / hazmat) rather than firing at
 *  someone — the subset of {@link UTILITY_EXT} that needs no aim. */
export const isSelfBuffExt = (ext: number): boolean =>
  ext === EXT_CODE.SHIELD || ext === EXT_CODE.HEAL || ext === EXT_CODE.ARMOR || ext === EXT_CODE.HAZMAT;
