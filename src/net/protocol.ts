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
  }>;
  /** Full terrain heightmap (per-column surface Y). */
  readonly heights: readonly number[];
  readonly wind: {readonly x: number; readonly y: number};
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
    }
  /** A Deathmatch battle ended but the war continues — advance to a fresh battle. `seed`
   *  regenerates the terrain identically on every client; `battle` is the new battle number. */
  | {readonly t: 'nextBattle'; readonly battle: number; readonly seed: number}
  /** The match ended; each client shows the standings (winner computed from synced state). */
  | {readonly t: 'gameOver'}
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
