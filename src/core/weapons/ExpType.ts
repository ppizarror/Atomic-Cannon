/**
 * `expType` — a weapon's EXPLOSION-STYLE selector (the `expType` field in the weapon data),
 * distinct from `extType` (the behaviour selector in {@link ./ExtType}). It picks the flare-burst
 * STYLE emitted at detonation; only the top tier (NUKE) also fires the full-screen white-out. This
 * module owns the value table ({@link EXP}), the type derived from it ({@link ExpType}), and the
 * narrowing that turns a raw JSON number into that type ({@link toExpType}).
 *
 * `ExpType` is NOMINAL on purpose, exactly like {@link ExtType}: an opaque token, NOT a plain
 * `number`, so a bare literal can never stand in for a style selector — `expType === 4` is a COMPILE
 * error (`expType === EXP.NUKE` is the only way to write it), which is what stops a value being
 * silently misrouted. The underlying runtime values are still the plain numbers 0..4 (the cast is
 * type-only), so `switch`, comparisons, and the weapon JSON are unaffected.
 */

/**
 * The complete 0..4 explosion-style map (no bare numbers anywhere). The distribution across the
 * weapon table is 0×2, 1×51, 2×28, 3×17, 4×6.
 */
const EXP_CODES = {
  PLAIN: 0, //  No flare burst — small kinetic rounds (Shotgun, Cannon).
  SINGLE: 1, // Single central puff — the common style (beams, rain, most bombs).
  BURST: 2, //  Scatter burst (~mag·0.5 flares + a central puff) — Bomb, Cleaner, Grave Digger.
  DENSE: 3, //  Dense scatter burst (~mag·2 flares) — Cluster, Digger, Plasma.
  NUKE: 4, //   Ring + puff + FULL-SCREEN saturating white-out — the 6 nukes.
} as const;

declare const EXP_BRAND: unique symbol;

/**
 * The authoritative explosion-style selector — a nominal, opaque token, deliberately NOT a
 * `number`. A weapon's expType is exactly one of the {@link EXP} members; a bare literal
 * (`expType === 4`) does not type-check, so a style can't be misrouted or invented.
 */
export type ExpType = {readonly [EXP_BRAND]: never};

/**
 * The explosion styles as nominal {@link ExpType} tokens — the ONLY way to name one. Same
 * keys/runtime values as the raw codes above; only the static type differs (the cast is erased),
 * so `EXP.NUKE` is `4` at runtime but an `ExpType` to the type-checker.
 */
export const EXP = EXP_CODES as unknown as {readonly [K in keyof typeof EXP_CODES]: ExpType};

const EXP_VALUES: ReadonlySet<number> = new Set(Object.values(EXP_CODES));

/**
 * Narrow a raw `expType` (as it comes off the weapon JSON) to the authoritative {@link ExpType}
 * token. Any value not in {@link EXP} — including a missing/garbage field — falls back to
 * {@link EXP.PLAIN}, the no-burst default.
 */
export function toExpType(n: number): ExpType {
  return (EXP_VALUES.has(n) ? n : EXP_CODES.PLAIN) as unknown as ExpType;
}

/** Nuke-tier explosion style — the only one that fires the full-screen white-out. */
export const isNukeExp = (exp: ExpType): boolean => exp === EXP.NUKE;
