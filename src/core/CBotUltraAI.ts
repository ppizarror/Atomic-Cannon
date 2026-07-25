/**
 * CBotUltraAI — the level-11 "Ultra" computer brain.
 *
 * Where levels 1..10 pick a random target + random weapon and then degrade a perfect solve by a
 * difficulty-scaled scatter, Ultra does the opposite: it enumerates every action it could take this
 * turn, scores each in one common "value" currency (≈ life-damage equivalent), and takes the best —
 * so it plays to WIN, not to fire.
 *
 * Actions considered every turn:
 *  • FIRE — for each enemy, solve ONE gust-aware arc (the trajectory is weapon-independent), then
 *    score EVERY owned weapon's blast at that impact over ALL tanks caught. Clustered enemies are
 *    rewarded automatically (multi-hit), kills carry a big bonus, and a nuke is only "worth it" for a
 *    kill or a 2+ hit — otherwise a cheap Shell is fired and the premium ordnance is BANKED.
 *  • MOVE — only ever with a concrete purpose: grab a nearby crate, flee radiation it's standing on,
 *    or reposition to unblock a shot when nothing reaches an enemy. Never the aimless wander lower
 *    levels do.
 *  • BUFF — heal / shield / armor / hazmat when a stat is low and there's no better play.
 *
 * The planner is PURE (all engine coupling is marshalled into `UltraCtx` by the caller), so the whole
 * brain is unit-testable without a running game.
 */
import {bestAim, simulateShot, type Pt, type AimField} from './CBotAI';

/** One enemy tank, in the units the scorer needs. `life`/`shield` are 0..maxLife / 0..1000. */
export interface UltraEnemy {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  shield: number;
  hitRadius: number;
}

/** One owned weapon, pre-resolved to the fields the blast scorer needs (the caller folds in
 *  Explosion Size + resolution so `radius` is the true falloff radius). */
export interface UltraWeapon {
  index: number;
  ext: number;
  cost: number; // credits to buy one (0 for the unlimited Shell staple)
  count: number; // rounds in stock (Infinity for the Shell)
  damage: number;
  radius: number; // outer falloff radius = getRadius × explosionScale × blastScale
  innerR: number; // full-damage core = 0.5 × getSize()
  spread: number; // extra effective reach from cluster/airburst submunitions raining over an area
  dotValue: number; // total damage-over-time a gas/radioactive round lays down (irDmg × irTime)
  earth: number; // dirt-dumping amount (>0 → can bury a target)
  piercing: boolean; // armor-piercing (radioactive) — bypasses shield/armor in the estimate
  isBeam: boolean; // hitscan straight-line ray (no arc; ignores terrain)
  isPremium: boolean; // nuke / expensive ordnance to reserve for high-value shots
  offensive: boolean; // a damaging round the bot may fire at a target
}

/** A supply crate the bot could drive onto. `bomb` is a trap (negative value). */
export interface UltraCrate {
  x: number;
  kind: 'weapon' | 'credits' | 'health' | 'bomb';
  amount: number; // credits / health payload
  landed: boolean; // false while still under its parachute — not yet where it will settle
}

/** The acting bot's own state. */
export interface UltraSelf {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  shield: number;
  armor: number;
  hazmat: number;
  credits: number;
  onRadiation: boolean; // standing on the fallout carpet right now
}

export interface UltraCtx {
  self: UltraSelf;
  enemies: UltraEnemy[];
  weapons: UltraWeapon[];
  crates: UltraCrate[];
  field: AimField;
  wind: Pt;
  gustT0: number; // launch-time gust clock (see CBotAI.simulateShot)
  muzzleFor: (deg: number) => Pt; // barrel tip for a candidate aim
  aimDegToward: (target: Pt) => number; // straight-line aim (for beams)
  moveMaxDist: number; // furthest the bot can drive this turn (0 → no Move utility owned)
  radiationAt: (x: number) => boolean; // is the fallout carpet under column x?
  rnd: () => number;
}

/** The chosen action. `note` is a short human/debug/test label for WHY. */
export type UltraPlan =
  | {action: 'fire'; weaponIndex: number; angleDeg: number; power: number; note: string}
  | {action: 'move'; destX: number; note: string}
  | {action: 'buff'; weaponIndex: number; note: string}
  | {action: 'skip'; note: string};

// ── Value model (all in ≈ life-damage units, so actions compare directly) ────────────────────────
const KILL_BONUS = 1200; // killing a tank removes a threat — worth more than its raw remaining life
const PREMIUM_WASTE = 4000; // penalty for spending a nuke on a shot that neither kills nor multi-hits
const CREDIT_VALUE = 0.35; // a credit is worth this much "now" (future weapons)
const WEAPON_CRATE_VALUE = 260; // a free weapon pickup
const RAD_FLEE_VALUE = 300; // escaping the fallout carpet (avoided DOT over the coming turns)
const REPOSITION_VALUE = 140; // moving to set up a shot beats wasting a turn on a guaranteed miss
const BURY_BONUS = 200; // dumping dirt on a weak, low target to trap it (earth weapon)
const DOT_WEIGHT = 0.5; // how much a gas/radioactive round's sustained damage counts (vs instant)
const HIT_MARGIN = 8; // arc counts as "reaches" the enemy within this + its radius
const TRICK_CHANCE = 0.15; // "human-ish": sometimes take a setup play over the raw-best shot
const CRATE_CLOSE_TOL = 24; // a crate may pull the bot this much closer to an enemy, no more

/** Blast damage this weapon would deal to one enemy centred at (cx,cy) — the engine's two-radius
 *  model (full inside the core, linear falloff to zero at the outer edge; beams = full everywhere).
 *  `spread` widens the OUTER reach so cluster/airburst rounds correctly catch tanks spread over an
 *  area (their submunitions rain wide), which is why Ultra reaches for them against a spread group. */
export function blastDamageToEnemy(cx: number, cy: number, w: UltraWeapon, e: UltraEnemy): number {
  const collR = e.hitRadius;
  const outer = Math.max(w.radius + w.spread, 0) + collR;
  const inner = w.innerR + collR;
  const dist = Math.hypot(e.x - cx, e.y - cy);
  if (dist > outer) return 0;
  if (w.isBeam || dist <= inner) return w.damage;
  return w.damage * (1 - dist / outer);
}

/** Effective HP the bot must chew through to KILL an enemy: life plus the shield (armor/hazmat are
 *  percentage soaks we fold in loosely). Piercing rounds bypass the shield. */
function effectiveHp(e: UltraEnemy, piercing: boolean): number {
  return e.life + (piercing ? 0 : e.shield);
}

/** Score a weapon detonating at (cx,cy): total EFFECTIVE damage across all enemies + a kill bonus
 *  per tank it would drop. Effective damage is capped at each tank's HP (no overkill credit). */
function scoreBlast(
  cx: number,
  cy: number,
  w: UltraWeapon,
  enemies: UltraEnemy[],
): {value: number; kills: number; hits: number} {
  let value = 0,
    kills = 0,
    hits = 0;
  for (const e of enemies) {
    const raw = blastDamageToEnemy(cx, cy, w, e);
    if (raw <= 0) continue;
    hits++;
    const hp = effectiveHp(e, w.piercing);
    value += Math.min(raw, hp); // don't reward overkill beyond what removes the tank
    if (raw >= hp) {
      kills++;
      value += KILL_BONUS;
    } else if (w.dotValue > 0) {
      // Gas / radioactive round: the fallout keeps chipping the survivor over the coming turns and
      // denies the ground — worth a chunk on top of the direct hit (capped at what remains + weighted,
      // since DOT is spread over time and the tank may crawl off it).
      value += Math.min(w.dotValue, hp - raw) * DOT_WEIGHT;
    }
  }
  return {value, kills, hits};
}

interface ShotPlan {
  weaponIndex: number;
  angleDeg: number;
  power: number;
  value: number;
  kills: number;
  hits: number;
  note: string;
}

/** The best offensive FIRE this turn, or null if no owned weapon reaches any enemy. One arc is
 *  solved per enemy (trajectory is weapon-independent); every owned weapon is then scored at that
 *  arc's impact so multi-tank blasts and cheap-vs-premium trade-offs are compared head to head. */
export function bestOffensiveShot(ctx: UltraCtx): ShotPlan | null {
  const {enemies, weapons, field, wind, gustT0, muzzleFor} = ctx;
  const firers = weapons.filter(w => w.offensive && w.count > 0 && w.damage > 0);
  if (!firers.length || !enemies.length) return null;

  let best: ShotPlan | null = null;
  const consider = (p: ShotPlan) => {
    if (
      !best ||
      p.value > best.value ||
      // Tie-break: prefer the CHEAPER weapon (bank the pricey stuff) at equal value.
      (p.value === best.value && weaponCost(weapons, p.weaponIndex) < weaponCost(weapons, best.weaponIndex))
    )
      best = p;
  };

  for (const e of enemies) {
    // BEAMS are hitscan: aim straight at the enemy, no arc. Score the beam on the direct line.
    for (const w of firers.filter(f => f.isBeam)) {
      const s = scoreBlast(e.x, e.y, w, enemies);
      if (s.hits > 0)
        consider({
          weaponIndex: w.index,
          angleDeg: ctx.aimDegToward({x: e.x, y: e.y}),
          power: 1000,
          value: adjustForPremium(w, s.value, s.kills, s.hits),
          kills: s.kills,
          hits: s.hits,
          note: `beam ${describe(s)}`,
        });
    }

    // BALLISTIC: solve one arc to this enemy, then score every arced weapon at its impact.
    const arc = bestAim(muzzleFor, {x: e.x, y: e.y}, wind, field, gustT0);
    const origin = muzzleFor(arc.angleDeg);
    const shot = simulateShot(origin, arc.angleDeg, arc.power, wind, field, {x: e.x, y: e.y}, gustT0);
    const reaches = shot.minDist <= e.hitRadius + HIT_MARGIN;
    // Detonation point: on the tank for a direct hit, else where it actually lands (terrain).
    const cx = reaches ? shot.nearX : shot.hitX;
    const cy = reaches ? shot.nearY : shot.hitY;
    if (!shot.hitGround && !reaches) continue; // sailed off the field → no blast

    for (const w of firers.filter(f => !f.isBeam)) {
      const s = scoreBlast(cx, cy, w, enemies);
      if (s.hits === 0) continue;
      let value = adjustForPremium(w, s.value, s.kills, s.hits);
      // Trap play: an earth (dirt-dumping) weapon on a weak, low target is worth a little extra even
      // when it barely damages — it buries them.
      if (w.earth > 0 && s.kills === 0 && enemyIsWeak(enemies, cx, cy)) value += BURY_BONUS;
      consider({
        weaponIndex: w.index,
        angleDeg: arc.angleDeg,
        power: arc.power,
        value,
        kills: s.kills,
        hits: s.hits,
        note: `${reaches ? 'hit' : 'splash'} ${describe(s)}`,
      });
    }
  }
  return best;
}

const weaponCost = (weapons: UltraWeapon[], index: number): number =>
  weapons.find(w => w.index === index)?.cost ?? 0;

/** Reserve premium ordnance: a nuke/expensive round is only worth its slot for a kill or a 2+ hit;
 *  otherwise it's penalised so a cheap weapon wins and the nuke stays banked. */
function adjustForPremium(w: UltraWeapon, value: number, kills: number, hits: number): number {
  if (w.isPremium && kills === 0 && hits < 2) return value - PREMIUM_WASTE;
  return value;
}

/** Is there a weak (≤40% life) enemy near the blast — a good candidate to bury rather than kill? */
function enemyIsWeak(enemies: UltraEnemy[], cx: number, cy: number): boolean {
  return enemies.some(
    e => e.life <= e.maxLife * 0.4 && Math.hypot(e.x - cx, e.y - cy) < e.hitRadius + 40,
  );
}

const describe = (s: {kills: number; hits: number}) => `k${s.kills} h${s.hits}`;

// ── Non-firing options ───────────────────────────────────────────────────────────────────────────

/** Value + destination of the best crate to grab (or null). Only LANDED crates are grabbed (a
 *  still-parachuting crate hasn't reached where it will settle — wait a turn), bomb crates are traps
 *  (never grabbed), and a crate that would bring the bot CLOSER to an enemy is skipped: an artillery
 *  bot keeps its distance rather than driving into the enemy's lap for a pickup. */
function bestCrateGrab(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, crates, enemies, moveMaxDist} = ctx;
  if (moveMaxDist <= 0) return null;
  const distToEnemies = (x: number) =>
    enemies.length ? Math.min(...enemies.map(e => Math.abs(e.x - x))) : Infinity;
  const dNow = distToEnemies(self.x);
  let best: {destX: number; value: number; note: string} | null = null;
  for (const c of crates) {
    if (!c.landed) continue; // still under its chute — not where it'll settle; wait for it to land
    if (Math.abs(c.x - self.x) > moveMaxDist) continue; // out of drive range
    if (c.kind === 'bomb') continue; // a trap — never a grab
    if (distToEnemies(c.x) < dNow - CRATE_CLOSE_TOL) continue; // don't close on the enemy for loot
    let value: number;
    if (c.kind === 'credits') value = c.amount * CREDIT_VALUE;
    else if (c.kind === 'health') value = Math.min(c.amount, self.maxLife - self.life);
    else value = WEAPON_CRATE_VALUE; // weapon
    if (value <= 0) continue;
    if (!best || value > best.value) best = {destX: c.x, value, note: `crate:${c.kind}`};
  }
  return best;
}

/** Nearest clean-ground destination within drive range when standing on fallout (or null). Scans
 *  outward from the bot so it hops just off the carpet rather than driving to the far edge. */
function bestRadiationEscape(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, moveMaxDist, radiationAt, field} = ctx;
  if (!self.onRadiation || moveMaxDist <= 0) return null;
  const step = 8;
  for (let d = step; d <= moveMaxDist; d += step) {
    for (const dir of [-1, 1]) {
      const x = self.x + dir * d;
      if (x < 20 || x > field.width - 20) continue;
      if (!radiationAt(x)) return {destX: x, value: RAD_FLEE_VALUE, note: 'flee-radiation'};
    }
  }
  return null;
}

/** Drive toward the nearest enemy to set up a shot next turn — the answer to "nothing reaches". */
function bestReposition(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, enemies, moveMaxDist, field} = ctx;
  if (moveMaxDist <= 0 || !enemies.length) return null;
  let near = enemies[0];
  for (const e of enemies) if (Math.abs(e.x - self.x) < Math.abs(near.x - self.x)) near = e;
  const dir = near.x >= self.x ? 1 : -1;
  const destX = clampX(self.x + dir * moveMaxDist, field);
  if (Math.abs(destX - self.x) < 4) return null; // already as close as we can get
  return {destX, value: REPOSITION_VALUE, note: 'reposition'};
}

/** Best self-buff when a stat is low (heal ≻ shield ≻ armor ≻ hazmat), scored by what it restores. */
function bestBuff(ctx: UltraCtx): {weaponIndex: number; value: number; note: string} | null {
  const {self, weapons} = ctx;
  const own = (ext: number) => weapons.find(w => w.ext === ext && w.count > 0);
  let best: {weaponIndex: number; value: number; note: string} | null = null;
  const offer = (w: UltraWeapon | undefined, value: number, note: string) => {
    if (w && value > 0 && (!best || value > best.value))
      best = {weaponIndex: w.index, value, note};
  };
  // Heal (ext 10): worth the life it would restore, only when actually hurt.
  if (self.life < self.maxLife * 0.6) offer(own(10), self.maxLife - self.life, 'heal');
  // Shield (ext 7): defensive stock when low and enemies are around.
  if (self.shield < 300) offer(own(7), (1000 - self.shield) * 0.25, 'shield');
  // Armor (ext 11) / Hazmat (ext 14): smaller top-ups.
  if (self.armor <= 0) offer(own(11), 120, 'armor');
  if (self.hazmat <= 0 && self.onRadiation) offer(own(14), 150, 'hazmat');
  return best;
}

const clampX = (x: number, field: AimField): number =>
  Math.max(20, Math.min(field.width - 20, x));

/**
 * The full Ultra decision: score every candidate action in one currency and take the best, with a
 * small "human-ish" chance to prefer a setup/trap play over the raw-best shot so it feels cunning
 * rather than robotic. Returns a {@link UltraPlan} the caller executes.
 */
export function planUltraTurn(ctx: UltraCtx): UltraPlan {
  type Cand = {plan: UltraPlan; value: number; trick: boolean};
  const cands: Cand[] = [];

  const shot = bestOffensiveShot(ctx);
  const firePlan = (): UltraPlan => ({
    action: 'fire',
    weaponIndex: shot!.weaponIndex,
    angleDeg: shot!.angleDeg,
    power: shot!.power,
    note: shot!.note,
  });
  // A guaranteed KILL is never passed up for a crate/move/buff — take the shot.
  if (shot && shot.kills > 0) return firePlan();
  if (shot) cands.push({plan: firePlan(), value: shot.value, trick: false});

  const crate = bestCrateGrab(ctx);
  if (crate) cands.push({plan: {action: 'move', destX: crate.destX, note: crate.note}, value: crate.value, trick: true});

  const flee = bestRadiationEscape(ctx);
  if (flee) cands.push({plan: {action: 'move', destX: flee.destX, note: flee.note}, value: flee.value, trick: false});

  const buff = bestBuff(ctx);
  if (buff) cands.push({plan: {action: 'buff', weaponIndex: buff.weaponIndex, note: buff.note}, value: buff.value, trick: false});

  // Reposition only matters when no shot actually reaches an enemy (else firing is better).
  if (!shot || shot.hits === 0) {
    const repo = bestReposition(ctx);
    if (repo) cands.push({plan: {action: 'move', destX: repo.destX, note: repo.note}, value: repo.value, trick: true});
  }

  if (!cands.length) return {action: 'skip', note: 'no-action'};

  cands.sort((a, b) => b.value - a.value);
  const top = cands[0];

  // Human-ish cunning: occasionally take a near-as-good SETUP play (crate/reposition) over the
  // raw-best shot — but never pass up a kill.
  if (top.plan.action === 'fire' && (shot?.kills ?? 0) === 0 && ctx.rnd() < TRICK_CHANCE) {
    const trick = cands.find(c => c.trick && c.value >= top.value * 0.6);
    if (trick) return trick.plan;
  }
  return top.plan;
}
