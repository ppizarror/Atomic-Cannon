/**
 * Network UI store — a signal mirror of the {@link RoomClient} lobby state plus
 * the actions the Network screen calls. Holds a single RoomClient; every state
 * change flows into `netState` so Preact re-renders. The game bridge for in-match
 * messages is wired in a later phase (`onGameMessage` below).
 */
import {signal} from '@preact/signals';
import {RoomClient, type RoomClientState} from '../net/roomClient';
import type {ServerMessage} from '../net/protocol';
import {normalizeRoomCode, isValidRoomCode} from '../net/roomCode';
import {createPersistedSignal} from './persistedSignal';
import {roster} from './playersStore';

const initialState: RoomClientState = {
  phase: 'idle',
  status: 'idle',
  code: '',
  youId: null,
  players: [],
  settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
  isHost: false,
  lastError: null,
};

/** The reactive lobby snapshot the Network screen renders from. */
export const netState = signal<RoomClientState>(initialState);

// The name you appear as online — defaults to your first configured player.
const nameStore = createPersistedSignal<string>('atomic.net.name', {
  revive: raw => String(raw),
  seed: () => roster.value[0]?.name ?? 'Player',
});
export const playerName = nameStore.signal;
export const setPlayerName = (name: string): void => nameStore.set(name);

let client: RoomClient | null = null;

function onGameMessage(_msg: ServerMessage): void {
  // Phase 2: route startGame / turnBegin / cmd / stateUpdate into the game bridge.
}

function makeClient(): RoomClient {
  client?.close();
  client = new RoomClient({
    identity: {name: playerName.value.trim() || 'Player', color: roster.value[0]?.color},
    onState: s => {
      netState.value = s;
    },
    onGameMessage,
  });
  return client;
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
export const startMatch = (): void => client?.startMatch();

/** Leave the room and reset the screen back to the entry state. */
export function leaveRoom(): void {
  client?.leave();
  client = null;
  netState.value = initialState;
}

/** Tear down without a graceful leave (e.g. navigating away). */
export function resetNet(): void {
  client?.close();
  client = null;
  netState.value = initialState;
}
