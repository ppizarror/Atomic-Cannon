/**
 * Network UI store — a signal mirror of the {@link RoomClient} lobby state plus
 * the actions the Network screen calls. Holds a single RoomClient; every state
 * change flows into `netState` so Preact re-renders. The game bridge for in-match
 * messages is wired in a later phase (`onGameMessage` below).
 */
import {signal} from '@preact/signals';
import {RoomClient, type RoomClientState} from '../net/roomClient';
import type {MatchConfig} from '../net/protocol';
import {NetGame} from '../net/netGame';
import {normalizeRoomCode, isValidRoomCode} from '../net/roomCode';
import {createPersistedSignal} from './persistedSignal';
import {roster} from './playersStore';
import {game, screen, paused, goToMenu} from './store';
import {strings, fmt} from '../i18n';

const initialState: RoomClientState = {
  phase: 'idle',
  status: 'idle',
  code: '',
  youId: null,
  players: [],
  settings: {
    maxPlayers: 6,
    minPlayers: 2,
    battles: 2,
    wind: 1,
    mapSize: 2,
    tanksPerTeam: 1,
    alternateTurns: false,
  },
  config: null,
  isHost: false,
  lastError: null,
};

/** The reactive lobby snapshot the Network screen renders from. */
export const netState = signal<RoomClientState>(initialState);

/** Set once a lockstep divergence is detected this match (a peer's keyframe disagreed with our own
 *  deterministic result — a cheat or a genuine desync). We keep our own trusted state; the UI shows
 *  a warning banner. Sticky for the match (cleared on a fresh room). */
export const netDesync = signal(false);

/** True when this client joined an in-progress match as a spectator (watching, no turn). */
export const netSpectating = signal(false);

/** One line in the in-match chat log. */
export interface ChatMsg {
  seq: number;
  name: string; // sender's display name (resolved from the roster)
  text: string;
  mine: boolean; // sent by the local player (styled as own message)
}

/** In-match chat transcript (most recent last), rendered by NetChat during a battle. */
export const chatLog = signal<ChatMsg[]>([]);
let chatSeq = 0;
const MAX_CHAT = 60; // cap the transcript so a long match can't grow it unbounded

function pushChat(fromId: number, text: string): void {
  const s = netState.value;
  const from = s.players.find(p => p.id === fromId);
  const msg: ChatMsg = {
    seq: ++chatSeq,
    name: from?.name ?? fmt(strings.value.net.playerNum, {n: fromId}),
    text,
    mine: fromId === s.youId,
  };
  chatLog.value = [...chatLog.value, msg].slice(-MAX_CHAT);
}

/** Send a chat line to everyone in the room (the server echoes it back, so no optimistic add). */
export function sendChat(text: string): void {
  const clean = text.trim().slice(0, 200);
  if (clean) client?.chat(clean);
}

// The name you appear as online — defaults to your first configured player.
const nameStore = createPersistedSignal<string>('atomic.net.name', {
  revive: raw => String(raw),
  seed: () => roster.value[0]?.name ?? 'Player',
});
export const playerName = nameStore.signal;
export const setPlayerName = (name: string): void => nameStore.set(name);

let client: RoomClient | null = null;
let netGame: NetGame | null = null;
let configPublished = false; // host publishes its lobby config once per room

function makeClient(): RoomClient {
  client?.close();
  configPublished = false;
  chatLog.value = []; // fresh transcript per room
  netDesync.value = false; // clear any prior match's divergence flag
  netSpectating.value = false;
  const c = new RoomClient({
    identity: {name: playerName.value.trim() || 'Player', color: roster.value[0]?.color},
    appVersion: __APP_VERSION__,
    onState: s => {
      netState.value = s;
      // As soon as we're the host in the lobby, publish our gameplay config so every joiner
      // sees the match settings before Start. Send once (the config doesn't change in-lobby yet).
      if (s.isHost && s.phase === 'lobby' && !configPublished) {
        configPublished = true;
        c.publishConfig(game().getMatchConfig());
      }
    },
    onGameMessage: msg => {
      // Chat is a UI concern, not a game-sim message — capture it here; NetGame ignores it.
      if (msg.t === 'chat') return pushChat(msg.from, msg.text);
      // The server flagged the whole match as contested (someone reported a divergence) — surface
      // it on this client too, even if WE weren't the one who detected the mismatch.
      if (msg.t === 'desyncFlag') return void (netDesync.value = true);
      netGame?.handle(msg);
    },
  });
  client = c;
  // The bridge boots the match from `startGame` and enters the battle screen.
  netGame = new NetGame(c, {
    controller: game(),
    onMatchStart: () => {
      screen.value = 'battle';
      game().setPaused(false);
      paused.value = false;
      netSpectating.value = game().isNetSpectator(); // joined mid-match with no turn slot
    },
    // True lockstep: we detected a peer's keyframe disagree with our own result. Keep our state,
    // flag it for the player, and report it so the server can log the divergent match.
    onDivergence: ({localHash, keyframeHash}) => {
      netDesync.value = true;
      console.warn(`[net] lockstep divergence — local ${localHash} vs keyframe ${keyframeHash}`);
      c.reportDesync(localHash, keyframeHash);
    },
  });
  return c;
}

function fail(message: string): void {
  netState.value = {...netState.value, phase: 'error', lastError: {code: 'bad_message', message}};
}

export async function createRoom(): Promise<void> {
  netState.value = {...initialState, phase: 'connecting'};
  try {
    await makeClient().create();
  } catch {
    fail('Could not reach the server to create a room.');
  }
}

export function joinRoom(raw: string): void {
  const code = normalizeRoomCode(raw);
  if (!isValidRoomCode(code)) {
    fail('That room code looks wrong — check it and try again.');
    return;
  }
  makeClient().join(code);
}

export const setReady = (ready: boolean): void => client?.setReady(ready);
// Start with THIS host's display size + the LIVE lobby config (host edits in the lobby, so
// prefer the published config over the host's raw Settings; fall back to Settings if unset).
export const startMatch = (): void =>
  client?.startMatch(
    game().getDisplayWidth(),
    game().getDisplayHeight(),
    netState.value.config ?? game().getMatchConfig(),
  );

/** Host-only: change a lobby room setting (wind / map size / max players); broadcast to all. */
export const updateSettings = (patch: Partial<RoomClientState['settings']>): void =>
  client?.updateSettings(patch);

/** Host-only: change a gameplay config field in the lobby. Merges onto the live published
 *  config and re-publishes so every player sees it (and it's applied identically at Start). */
export const updateMatchConfig = (patch: Partial<MatchConfig>): void => {
  const base = netState.value.config ?? game().getMatchConfig();
  client?.publishConfig({...base, ...patch});
};

/** Leave the room and reset the screen back to the entry state. */
export function leaveRoom(): void {
  client?.leave();
  client = null;
  netGame = null;
  netState.value = initialState;
}

/** Tear down without a graceful leave (e.g. navigating away). */
export function resetNet(): void {
  client?.close();
  client = null;
  netGame = null;
  netState.value = initialState;
}

/** End the current networked match: leave the room and return to the main menu. */
export function leaveMatch(): void {
  leaveRoom();
  goToMenu();
}
