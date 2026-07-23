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
  | {readonly t: 'start'} // host only
  | {readonly t: 'settings'; readonly settings: Partial<RoomSettings>} // host only
  | {readonly t: 'cmd'; readonly seq: number; readonly cmd: GameCommand}
  | {
      readonly t: 'shotResult';
      readonly seq: number;
      readonly result: ShotResult;
      /** The acting client detected the battle ended on this shot (one team left). */
      readonly over?: boolean;
    }
  | {readonly t: 'chat'; readonly text: string}
  | {readonly t: 'leave'};

// ── Room → client ──────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      readonly t: 'welcome';
      readonly you: number;
      readonly code: string;
      readonly players: readonly PlayerInfo[];
      readonly settings: RoomSettings;
      readonly reconnect: string; // token to resume this slot if dropped
    }
  | {readonly t: 'roster'; readonly players: readonly PlayerInfo[]}
  | {readonly t: 'settings'; readonly settings: RoomSettings}
  | {readonly t: 'chat'; readonly from: number; readonly text: string}
  | {readonly t: 'startGame'; readonly seed: number; readonly order: readonly number[]}
  | {readonly t: 'turnBegin'; readonly playerIdx: number; readonly deadline: number}
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
