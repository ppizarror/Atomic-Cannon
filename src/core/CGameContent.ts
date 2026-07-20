/**
 * GameContent — the ACTIVE enabled sets for the running match: which weapons and
 * landscapes are in play. Written from the persisted Game Content editor at game
 * start (see ui/applySettings), read by the depot buy list, auto-buy, the bot
 * arsenal and the landscape picker. A disabled index is simply absent from play.
 *
 * Sets hold the DISABLED indices (empty = everything on), so the common "all enabled"
 * case is the empty-set default.
 */
export const GameContent = {
  weaponsOff: new Set<number>(), // disabled weapon indices (into WEAPON_DATABASE)
  landsOff: new Set<number>(), // disabled landscape indices (into LAND_DATA)
};

/** Is weapon index `i` enabled for play? */
export const weaponEnabled = (i: number): boolean => !GameContent.weaponsOff.has(i);

/** Is landscape index `i` enabled for play? */
export const landEnabled = (i: number): boolean => !GameContent.landsOff.has(i);
