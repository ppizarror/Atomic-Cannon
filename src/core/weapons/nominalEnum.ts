/**
 * Runtime machinery shared by the nominal-enum modules (ExtType, ExpType): from the raw
 * `codes` table and the `fallback` key it builds the branded token object and the narrower
 * that turns a raw JSON number into a token (unknown values → the fallback).
 *
 * The BRAND stays per-module — each enum declares its own `unique symbol` + branded type and
 * passes it as `T` — so the enums remain DISTINCT nominal types (an `ExpType` still can't be
 * used where an `ExtType` is wanted); only this boilerplate is de-duplicated.
 */
export function makeNominalEnum<T, C extends Record<string, number>>(
  codes: C,
  fallback: keyof C,
): {
  /** `codes` re-typed so each member reads as the branded token `T` (runtime value unchanged). */
  tokens: {readonly [K in keyof C]: T};
  /** Narrow a raw number to a token; anything not in `codes` becomes `codes[fallback]`. */
  toType: (n: number) => T;
} {
  const values = new Set<number>(Object.values(codes));
  const fallbackValue = codes[fallback];
  return {
    tokens: codes as unknown as {readonly [K in keyof C]: T},
    toType: (n: number): T => (values.has(n) ? n : fallbackValue) as unknown as T,
  };
}
