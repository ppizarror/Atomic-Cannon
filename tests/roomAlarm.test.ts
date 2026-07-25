/**
 * Server-side turn deadline / AFK forfeit. The Room Durable Object arms an alarm at each
 * turn's deadline; if the active player never acts, the alarm force-advances the turn so a
 * connected-but-idle player can't stall the room forever. These tests drive the DO's `alarm()`
 * against a mock DurableObjectState and assert the forfeit / re-arm / no-op branches.
 */
import {describe, it, expect} from 'vitest';
import {Room} from '../worker/Room';

interface FakeSocket {
  sent: string[];
  send(raw: string): void;
  deserializeAttachment(): unknown;
}
const makeSocket = (playerId: number | null = null): FakeSocket => {
  const sent: string[] = [];
  return {
    sent,
    send: (raw: string) => sent.push(raw),
    deserializeAttachment: () => ({playerId}),
  };
};
const msgs = (ws: FakeSocket): Record<string, unknown>[] =>
  ws.sent.map(s => JSON.parse(s) as Record<string, unknown>);

/** Deliver a client message through the DO's handler (the FakeSocket stands in for a WebSocket). */
const deliver = (room: Room, ws: FakeSocket, obj: unknown): Promise<void> =>
  room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(obj));

function makeRoom(state: Record<string, unknown>, sockets: FakeSocket[]) {
  const store = new Map<string, unknown>([['room', state]]);
  let alarmAt: number | null = null;
  const ctx = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      setAlarm: async (t: number) => void (alarmAt = t),
      deleteAlarm: async () => void (alarmAt = null),
    },
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const room = new Room(ctx as any, {} as any);
  return {
    room,
    stored: () => store.get('room') as Record<string, unknown>,
    alarmAt: () => alarmAt,
  };
}

/** A two-player match mid-play, player 1's tank (turn 0) active. `over` patches fields. */
function playingState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'ROOM',
    phase: 'playing',
    nextId: 3,
    hostId: 1,
    settings: {
      maxPlayers: 6,
      minPlayers: 2,
      battles: 1,
      wind: 1,
      mapSize: 2,
      tanksPerTeam: 1,
      alternateTurns: false,
    },
    players: {
      1: {id: 1, name: 'A', color: '#f00', ready: true, token: 't1', connected: true, isHost: true},
      2: {
        id: 2,
        name: 'B',
        color: '#0f0',
        ready: true,
        token: 't2',
        connected: true,
        isHost: false,
      },
    },
    seed: 123,
    order: [1, 2],
    turnIdx: 0,
    turnDeadline: Date.now() - 1000, // already elapsed by default
    viewW: 1280,
    viewH: 720,
    config: {gameType: 1},
    totalBattles: 1,
    currentBattle: 1,
    tanksPerTeam: 1,
    alternateTurns: false,
    snapshot: null,
    snapshotHash: 0,
    appVersion: 'v',
    contested: false,
    ...over,
  };
}

const turnBegins = (ws: FakeSocket): Record<string, unknown>[] =>
  ws.sent.map(s => JSON.parse(s) as Record<string, unknown>).filter(m => m.t === 'turnBegin');

describe('Room AFK forfeit alarm', () => {
  it('an elapsed deadline force-advances the turn to the next living player', async () => {
    const a = makeSocket();
    const b = makeSocket();
    const {room, stored, alarmAt} = makeRoom(playingState(), [a, b]);

    await room.alarm();

    expect(stored().turnIdx).toBe(1); // advanced off the idle player
    const tb = turnBegins(a);
    expect(tb).toHaveLength(1);
    expect(tb[0].playerIdx).toBe(1); // the next tank
    expect(tb[0].handoff).toBe(true); // the forfeited turn still runs per-turn effects
    expect(tb[0].deadline as number).toBeGreaterThan(0); // a fresh budget for the successor
    expect(alarmAt()).not.toBeNull(); // re-armed for the new turn
    expect(alarmAt() as number).toBeGreaterThan(Date.now()); // in the future
  });

  it('a deadline still in the future re-arms without forfeiting', async () => {
    const a = makeSocket();
    const {room, stored, alarmAt} = makeRoom(playingState({turnDeadline: Date.now() + 60_000}), [
      a,
    ]);

    await room.alarm();

    expect(stored().turnIdx).toBe(0); // turn NOT advanced
    expect(turnBegins(a)).toHaveLength(0); // no hand-off broadcast
    expect(alarmAt()).not.toBeNull(); // re-armed for the remaining time
  });

  it('does nothing once the match has ended', async () => {
    const a = makeSocket();
    const {room, stored} = makeRoom(playingState({phase: 'ended'}), [a]);

    await room.alarm();

    expect(stored().turnIdx).toBe(0);
    expect(turnBegins(a)).toHaveLength(0);
  });
});

describe('Room message validation (net robustness)', () => {
  it('rejects a malformed shotResult without poisoning the stored snapshot (NET-1/3)', async () => {
    const actor = makeSocket(1); // owns turn 0 (order[0] = 1)
    const {room, stored} = makeRoom(playingState({snapshot: null}), [actor]);

    await deliver(room, actor, {
      t: 'shotResult',
      seq: 1,
      hash: 0,
      over: false,
      result: {tanks: [null], heights: [], wind: {x: 0, y: 0}, rngState: 0}, // the room-bricking payload
    });

    expect(stored().snapshot).toBeNull(); // NOT stored → no future reconnect/spectator crash
    expect(stored().turnIdx).toBe(0); // turn not advanced
    expect(msgs(actor).some(m => m.t === 'error' && m.code === 'bad_message')).toBe(true);
  });

  it('rejects a malformed cmd instead of relaying it to peers (NET-4)', async () => {
    const actor = makeSocket(1);
    const spectator = makeSocket(2);
    const {room} = makeRoom(playingState(), [actor, spectator]);

    await deliver(room, actor, {t: 'cmd', seq: 1, cmd: {t: 'move', destX: NaN}}); // would drive peers' tank to NaN

    expect(msgs(actor).some(m => m.t === 'error' && m.code === 'bad_message')).toBe(true);
    expect(msgs(spectator).some(m => m.t === 'cmd')).toBe(false); // never relayed
  });

  it('rejects a start once the match is under way (NET-5)', async () => {
    const host = makeSocket(1); // hostId = 1
    const {room, stored} = makeRoom(playingState({seed: 999}), [host]);

    await room.webSocketMessage(
      host,
      JSON.stringify({t: 'start', viewW: 1280, viewH: 720, config: {}}),
    );

    expect(stored().seed).toBe(999); // seed NOT re-rolled — clients not yanked into a new world
    expect(msgs(host).some(m => m.t === 'error' && m.code === 'game_in_progress')).toBe(true);
  });
});
