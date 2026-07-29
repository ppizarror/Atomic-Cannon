/**
 * The WebSocket wire protocol — an isomorphic tagged union shared by the browser
 * client and the room Durable Object. A compact turn-based room protocol:
 * clients send intents, the room arbitrates turns + relays, and the acting
 * client streams its authoritative `shotResult`.
 *
 * WebSocket already gives us reliable+ordered delivery, so there's no explicit
 * framing; messages are JSON. Everything here is plain data — no DOM, no Workers
 * API — so both ends import it directly.
 */
import type {GameCommand} from './commands';

/** Protocol version — clients declare it on hello; the room rejects mismatches. */
export const PROTOCOL_VERSION = 1;

/** A player's lobby/roster identity (never carries secrets — reconnectToken stays server-side). */
export interface PlayerInfo {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly isHost: boolean;
  /** A watcher who joined mid-match: not in the turn order, never plays. */
  readonly spectator?: boolean;
}

/** Room-level settings the host controls. */
export interface RoomSettings {
  readonly maxPlayers: number;
  readonly minPlayers: number;
  readonly battles: number;
  /** Host-chosen wind strength: 0 = calm, 1 = normal, 2 = strong. */
  readonly wind: number;
  /** Host-chosen map width in viewport-widths (1 = single screen … 5 = widest). */
  readonly mapSize: number;
  /** Tanks each player commands — a squad (1..4). Every player fields the same count. */
  readonly tanksPerTeam: number;
  /** Interleave team turns (A1,B1,A2,B2) instead of contiguous squads (A1,A2,B1,B2). */
  readonly alternateTurns: boolean;
}

/**
 * The host's gameplay settings, captured at Start and applied identically on every client so
 * the deterministic simulation agrees. ANY of these that a client read from its own local
 * Settings instead would diverge the world (physics scalars change trajectories/blast/damage;
 * gameType changes the damage model; buryTanks/relativeTurrets change positions/aim). The host
 * is the single source of truth — clients never read their own copy of these during a net match.
 */
export interface MatchConfig {
  readonly hitpoints: number; // tank starting/max life
  readonly tankSizeScale: number; // hull + collision geometry
  readonly explosionScale: number; // blast/carve radius
  readonly powerScale: number; // shot launch speed
  readonly kickbackScale: number; // post-fire tank recoil displacement
  readonly buryTanks: boolean; // a tank can be trapped underground (rest-Y)
  readonly variance: boolean; // per-shot inaccuracy (gates a seeded-RNG draw + jitters the arc)
  readonly relativeTurrets: boolean; // human aim is relative to the tank's terrain tilt
  readonly utilityTurn: boolean; // using a utility ends the turn
  // Scatter the spawn slots instead of landing each squad as one block. Sim-affecting: it decides
  // where every tank stands, so a client running its own copy would build a different battlefield.
  readonly randomizePosition: boolean;
  readonly roundTime: number; // per-turn shot clock in seconds (0 = off) — host owns it so all clients agree
  readonly crateChance: number; // supply-crate drop chance (gates the seeded RNG)
  readonly radiationDamage: boolean; // fallout deals DOT to tanks on it (vs cosmetic-only) — sim-affecting
  readonly startCredits: number; // starting purse per tank
  readonly gameType: number; // 0 = Rounds/Points, 1 = Deathmatch (damage model)
  // Economy rates — must match so every client awards/refunds the same credits (buys are relayed,
  // earning runs in every client's sim; a rate mismatch would diverge credit balances).
  readonly sellRate: number; // depot sell-back fraction (0..1)
  readonly creditDamage: number; // credits earned per point of life removed
  readonly creditKill: number; // credits earned per kill (Deathmatch)
  readonly creditTurn: number; // credits earned by each survivor per turn
  readonly creditRound: number; // credits earned by each survivor per round
}

/**
 * Authoritative post-turn state the acting client broadcasts once its shot resolves;
 * everyone applies it so tanks + terrain + wind stay in sync. Structurally matches the
 * controller's NetSnapshot (identity mapping, no per-field translation).
 */
export interface ShotResult {
  readonly tanks: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly life: number;
    readonly shield: number;
    readonly armor: number;
    readonly hazmat: number;
    readonly credits: number;
    /** Explicit alive flag — Rounds/Points tanks sit at 0 life yet ALIVE, so a bootstrapping client
     *  must adopt this rather than re-deriving alive from life. */
    readonly alive: boolean;
  }>;
  /** Full terrain heightmap (per-column surface Y). */
  readonly heights: readonly number[];
  readonly wind: {readonly x: number; readonly y: number};
  /** The seeded-gameplay-RNG cursor at this snapshot. A reconnecting/late-joining client MUST
   *  restore it (the state hash mixes the cursor), or its sim runs out of phase with the room and
   *  false-flags a desync on the next shot. See CGameController.applyNetSnapshot. */
  readonly rngState: number;
  /** Deployed mines, authoritative so a reconnecting/keyframe client reproduces them (position, arm
   *  countdown, weapon, owner-BY-INDEX; -1 = ownerless). Optional for back-compat with older peers. */
  readonly mines?: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly armed: number;
    readonly weaponIndex: number;
    readonly ownerIdx: number;
  }>;
  /** Supply crates on the field, authoritative so a reconnecting/keyframe client reproduces them
   *  (a missed crate diverges the hash on pickup). `kind`: weapon|credits|health|bomb. Optional. */
  readonly crates?: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly vy: number;
    readonly kind: string;
    readonly amount: number;
    readonly weaponIndex: number;
    readonly landed: boolean;
  }>;
}

// ── Client → room ──────────────────────────────────────────────────────────

export type ClientMessage =
  | {
      readonly t: 'hello';
      readonly v: number;
      /** App build version — a room must be single-version so game logic agrees. */
      readonly app: string;
      readonly name: string;
      readonly color?: string;
      readonly reconnect?: string;
    }
  | {readonly t: 'ready'; readonly ready: boolean}
  | {readonly t: 'config'; readonly config: MatchConfig} // host only: publish gameplay config to lobby
  | {
      // host only: its resolution + the gameplay config every client must adopt
      readonly t: 'start';
      readonly viewW: number;
      readonly viewH: number;
      readonly config: MatchConfig;
    }
  | {readonly t: 'settings'; readonly settings: Partial<RoomSettings>} // host only
  | {readonly t: 'cmd'; readonly seq: number; readonly cmd: GameCommand}
  | {
      readonly t: 'shotResult';
      readonly seq: number;
      readonly result: ShotResult;
      /** The acting client's authoritative post-turn state hash (drift detection). */
      readonly hash: number;
      /** The acting client detected the battle ended on this shot (one team left). */
      readonly over?: boolean;
      /** The turn-generation this result settles (from the turnBegin that opened it). The server
       *  REQUIRES it (rejects a result that omits it) and drops any result whose gen isn't the live
       *  one, so a duplicate/stale/crafted result can't be re-consumed. Typed optional only because
       *  the wire is untrusted — the server validates presence rather than the type guaranteeing it. */
      readonly turnGen?: number;
    }
  | {readonly t: 'chat'; readonly text: string}
  // A spectator's own deterministic result disagreed with the acting client's keyframe — a cheat or
  // a genuine desync. Reported for server-side flagging/logging; the reporter keeps its own state.
  | {readonly t: 'desync'; readonly localHash: number; readonly keyframeHash: number}
  | {readonly t: 'leave'};

// ── Room → client ──────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      readonly t: 'welcome';
      readonly you: number;
      readonly code: string;
      readonly players: readonly PlayerInfo[];
      readonly settings: RoomSettings;
      /** The host's gameplay config, shown in the lobby so joiners see it before Start. */
      readonly config: MatchConfig | null;
      readonly reconnect: string; // token to resume this slot if dropped
    }
  | {readonly t: 'roster'; readonly players: readonly PlayerInfo[]}
  | {readonly t: 'settings'; readonly settings: RoomSettings}
  | {readonly t: 'config'; readonly config: MatchConfig} // host's lobby gameplay config, for display
  | {readonly t: 'chat'; readonly from: number; readonly text: string}
  | {
      readonly t: 'startGame';
      readonly seed: number;
      readonly order: readonly number[];
      /** Match settings captured at start (so a reconnect rebuilds an identical world). */
      readonly wind: number;
      readonly mapSize: number;
      /** War length — number of battles (Deathmatch); 1 for Rounds/Points. */
      readonly battles: number;
      /** Tanks each player commands (1..4) — the shared squad size. */
      readonly tanksPerTeam: number;
      /** Which battle this boot is (1-based) — >1 when replayed to a reconnect mid-war. */
      readonly currentBattle: number;
      /** The host's logical resolution — the shared world size every client builds at. */
      readonly viewW: number;
      readonly viewH: number;
      /** The host's gameplay settings, applied identically on every client (determinism). */
      readonly config: MatchConfig;
    }
  | {
      readonly t: 'turnBegin';
      readonly playerIdx: number;
      readonly deadline: number;
      /** True when this turn begins right after a SHOT (a real hand-off) → run the once-per-turn
       *  effects (seeded crate roll + per-turn income). False for the match/battle's first turn. */
      readonly handoff?: boolean;
      /** True when the turn order just wrapped (a full round completed) → award per-round income. */
      readonly roundWrapped?: boolean;
      /** This turn's generation — the actor echoes it in its shotResult so a stale/duplicate result
       *  (an old gen) is rejected. Optional for back-compat with older peers. */
      readonly turnGen?: number;
    }
  /** A Deathmatch battle ended but the war continues — advance to a fresh battle. `seed`
   *  regenerates the terrain identically on every client; `battle` is the new battle number. */
  | {readonly t: 'nextBattle'; readonly battle: number; readonly seed: number}
  /** The match ended; each client shows the standings (winner computed from synced state). */
  | {readonly t: 'gameOver'}
  // A lockstep divergence was reported in this match — flag every client (incl. late joiners) so
  // the whole room knows the state is contested (detection, not correction).
  | {readonly t: 'desyncFlag'}
  /** A validated intent from the acting player, relayed for spectators to apply. */
  | {readonly t: 'cmd'; readonly from: number; readonly seq: number; readonly cmd: GameCommand}
  /** The acting player's authoritative shot outcome, applied by everyone. */
  | {
      readonly t: 'stateUpdate';
      readonly from: number;
      readonly seq: number;
      readonly result: ShotResult;
      readonly hash: number;
    }
  | {readonly t: 'kick'; readonly reason: string}
  | {readonly t: 'quit'; readonly reason: string}
  | {readonly t: 'error'; readonly code: ErrorCode; readonly message: string};

export type ErrorCode =
  | 'version_mismatch'
  | 'room_full'
  | 'not_host'
  | 'not_your_turn'
  | 'bad_message'
  | 'game_in_progress'
  | 'not_enough_players'
  | 'name_taken';

/** Narrowing helpers (defensive parse at the socket boundary). */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.t === 'string' ? (m as ClientMessage) : null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.t === 'string' ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
// Weapon indices are into the ~104-entry database; a generous cap rejects wild out-of-range values
// (which would index arrays on peers) without coupling the validator to the exact DB length.
const MAX_WEAPON_INDEX = 1000;
const CRATE_KINDS = new Set(['weapon', 'credits', 'health', 'bomb']);

/**
 * Structural validation of an actor's authoritative {@link ShotResult} BEFORE the server stores or
 * broadcasts it. `parseClientMessage` only checks `t`, so a malformed `result` (a `null`/short tank
 * array, non-finite fields, a wrong-length heightmap) would otherwise poison the stored snapshot and
 * crash — or NaN-corrupt — every reconnecting/spectating client that adopts it. `tankCount` is the
 * room's known total tank count.
 */
export function isValidShotResult(r: unknown, tankCount: number): r is ShotResult {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (!Array.isArray(o.tanks) || o.tanks.length !== tankCount) return false;
  for (const t of o.tanks) {
    if (!t || typeof t !== 'object') return false;
    const tk = t as Record<string, unknown>;
    if (
      !isFiniteNum(tk.x) ||
      !isFiniteNum(tk.y) ||
      !isFiniteNum(tk.life) ||
      !isFiniteNum(tk.shield) ||
      !isFiniteNum(tk.armor) ||
      !isFiniteNum(tk.hazmat) ||
      !isFiniteNum(tk.credits) ||
      typeof tk.alive !== 'boolean'
    ) {
      return false;
    }
  }
  if (!Array.isArray(o.heights) || o.heights.length === 0 || o.heights.length > 100_000)
    return false;
  for (const h of o.heights) if (!isFiniteNum(h)) return false;
  const w = o.wind as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object' || !isFiniteNum(w.x) || !isFiniteNum(w.y)) return false;
  if (!isFiniteNum(o.rngState)) return false;
  // Mines are optional (older peers omit them); if present, every entry must be well-formed. Indices
  // are integer + range-checked — peers use them to index the tank/weapon arrays, so a huge or
  // fractional value must not slip through (ownerIdx -1 = ownerless; otherwise a real tank index).
  if (o.mines !== undefined) {
    if (!Array.isArray(o.mines) || o.mines.length > 10_000) return false;
    for (const m of o.mines) {
      if (!m || typeof m !== 'object') return false;
      const mk = m as Record<string, unknown>;
      if (
        !isFiniteNum(mk.x) ||
        !isFiniteNum(mk.y) ||
        !isFiniteNum(mk.armed) ||
        !isInt(mk.weaponIndex) ||
        mk.weaponIndex < 0 ||
        mk.weaponIndex > MAX_WEAPON_INDEX ||
        !isInt(mk.ownerIdx) ||
        mk.ownerIdx < -1 ||
        mk.ownerIdx >= tankCount
      ) {
        return false;
      }
    }
  }
  // Crates optional; kind must be one of the four, weaponIndex integer in range (-1 = none).
  if (o.crates !== undefined) {
    if (!Array.isArray(o.crates) || o.crates.length > 1_000) return false;
    for (const c of o.crates) {
      if (!c || typeof c !== 'object') return false;
      const ck = c as Record<string, unknown>;
      if (
        !isFiniteNum(ck.x) ||
        !isFiniteNum(ck.y) ||
        !isFiniteNum(ck.vy) ||
        !isFiniteNum(ck.amount) ||
        !isInt(ck.weaponIndex) ||
        ck.weaponIndex < -1 ||
        ck.weaponIndex > MAX_WEAPON_INDEX ||
        typeof ck.landed !== 'boolean' ||
        typeof ck.kind !== 'string' ||
        !CRATE_KINDS.has(ck.kind)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Structural validation of a relayed {@link GameCommand}-shaped object BEFORE the server rebroadcasts
 * it to peers. A malformed `cmd` (null, an unknown `t`, non-finite index/coords) would crash or
 * NaN-corrupt every peer's `applyCommand`. Kept in sync with the command union in `net/commands.ts`.
 */
export function isValidGameCommand(cmd: unknown): boolean {
  if (!cmd || typeof cmd !== 'object') return false;
  const c = cmd as Record<string, unknown>;
  switch (c.t) {
    case 'resetAim':
    case 'autobuy':
    case 'cutJet':
    case 'fire':
      return true;
    case 'aim':
      return isFiniteNum(c.angle) && isFiniteNum(c.power);
    case 'selectWeapon':
    case 'buy':
    case 'sell':
      return isFiniteNum(c.index) && Number.isInteger(c.index);
    case 'move':
      return isFiniteNum(c.destX);
    case 'jet':
      return (
        typeof c.up === 'boolean' && typeof c.left === 'boolean' && typeof c.right === 'boolean'
      );
    default:
      return false;
  }
}
