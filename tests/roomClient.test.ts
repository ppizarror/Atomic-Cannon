/**
 * RoomClient lifecycle: create mints a code and connects; on open it sends hello;
 * welcome populates roster + host flag + reconnect token; a reconnect re-sends
 * hello WITH the token; errors surface; roster updates recompute host.
 */
import {describe, it, expect} from 'vitest';
import {
  RoomClient,
  roomUrl,
  type RoomClientState,
  type RoomClientOptions,
} from '../src/net/roomClient';
import type {NetTransport, ConnStatus} from '../src/net/transport';
import type {ClientMessage, ServerMessage, PlayerInfo} from '../src/net/protocol';

/** A hand-driven transport that records sends and lets tests push status/messages. */
class FakeTransport implements NetTransport {
  status: ConnStatus = 'idle';
  sent: ClientMessage[] = [];
  private msgCb: ((m: ServerMessage) => void) | null = null;
  private statusCb: ((s: ConnStatus) => void) | null = null;
  constructor(public url: string) {}
  connect() {
    this.setStatus('connecting');
  }
  send(m: ClientMessage) {
    this.sent.push(m);
  }
  onMessage(cb: (m: ServerMessage) => void) {
    this.msgCb = cb;
    return () => {};
  }
  onStatus(cb: (s: ConnStatus) => void) {
    this.statusCb = cb;
    return () => {};
  }
  close() {
    this.setStatus('closed');
  }
  // helpers
  setStatus(s: ConnStatus) {
    this.status = s;
    this.statusCb?.(s);
  }
  recv(m: ServerMessage) {
    this.msgCb?.(m);
  }
}

const player = (id: number, over: Partial<PlayerInfo> = {}): PlayerInfo => ({
  id,
  name: `P${id}`,
  color: '#fff',
  ready: false,
  connected: true,
  isHost: id === 1,
  ...over,
});

function harness(over: Partial<RoomClientOptions> = {}) {
  const transports: FakeTransport[] = [];
  const states: RoomClientState[] = [];
  const client = new RoomClient({
    identity: {name: 'Ada', color: '#f00'},
    appVersion: 'test',
    origin: 'https://example.com',
    mintCode: async () => 'ABCD23',
    transportFactory: (url: string) => {
      const t = new FakeTransport(url);
      transports.push(t);
      return t;
    },
    onState: s => states.push({...s}),
    ...over,
  });
  return {client, transports, states, last: () => states[states.length - 1]};
}

describe('roomUrl', () => {
  it('maps http(s) origin → ws(s) room path', () => {
    expect(roomUrl('https://example.com', 'ABCD23')).toBe('wss://example.com/room/ABCD23');
    expect(roomUrl('http://localhost:8787', 'ABCD23')).toBe('ws://localhost:8787/room/ABCD23');
  });
});

describe('RoomClient', () => {
  it('create() mints a code and connects to its room URL', async () => {
    const {client, transports} = harness();
    const code = await client.create();
    expect(code).toBe('ABCD23');
    expect(transports).toHaveLength(1);
    expect(transports[0].url).toBe('wss://example.com/room/ABCD23');
  });

  it('sends hello on open, then welcome fills the lobby', async () => {
    const {client, transports, last} = harness();
    await client.create();
    const t = transports[0];

    t.setStatus('open');
    expect(t.sent[0]).toEqual({
      t: 'hello',
      v: 1,
      app: 'test',
      name: 'Ada',
      color: '#f00',
      reconnect: undefined,
    });

    t.recv({
      t: 'welcome',
      you: 1,
      code: 'ABCD23',
      players: [player(1)],
      settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
      reconnect: 'tok-1',
    });
    const s = last();
    expect(s.phase).toBe('lobby');
    expect(s.youId).toBe(1);
    expect(s.isHost).toBe(true);
    expect(s.players).toHaveLength(1);
  });

  it('reconnect re-sends hello WITH the stored token', async () => {
    const {client, transports} = harness();
    await client.create();
    const t = transports[0];
    t.setStatus('open');
    t.recv({
      t: 'welcome',
      you: 2,
      code: 'ABCD23',
      players: [player(1), player(2)],
      settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
      reconnect: 'tok-2',
    });

    // Simulate a drop → the transport reopens and RoomClient re-identifies.
    t.setStatus('reconnecting');
    t.setStatus('open');
    const lastHello = t.sent.filter(m => m.t === 'hello').at(-1);
    expect(lastHello).toEqual({
      t: 'hello',
      v: 1,
      app: 'test',
      name: 'Ada',
      color: '#f00',
      reconnect: 'tok-2',
    });
  });

  it('recomputes host from roster updates (host leaves → next becomes host)', async () => {
    const {client, transports, last} = harness();
    await client.create();
    const t = transports[0];
    t.setStatus('open');
    t.recv({
      t: 'welcome',
      you: 2,
      code: 'ABCD23',
      players: [player(1), player(2)],
      settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
      reconnect: 'tok-2',
    });
    expect(last().isHost).toBe(false);

    // Host (id 1) leaves; id 2 is promoted.
    t.recv({t: 'roster', players: [player(2, {isHost: true})]});
    expect(last().isHost).toBe(true);
  });

  it('surfaces server errors', async () => {
    const {client, transports, last} = harness();
    await client.create();
    const t = transports[0];
    t.setStatus('open');
    t.recv({t: 'error', code: 'room_full', message: 'room is full'});
    expect(last().phase).toBe('error');
    expect(last().lastError).toEqual({code: 'room_full', message: 'room is full'});
  });

  it('ready/start/settings/chat go out on the wire', async () => {
    const {client, transports} = harness();
    await client.create();
    const t = transports[0];
    t.setStatus('open');
    t.sent.length = 0; // drop the hello

    client.setReady(true);
    const cfg = {
      hitpoints: 1000,
      tankSizeScale: 1,
      explosionScale: 1,
      powerScale: 1,
      kickbackScale: 1,
      buryTanks: false,
      relativeTurrets: false,
      utilityTurn: false,
      crateChance: 20,
      startCredits: 3000,
      gameType: 1,
    };
    client.startMatch(1280, 720, cfg);
    client.updateSettings({battles: 5});
    client.chat('hi');
    expect(t.sent).toEqual([
      {t: 'ready', ready: true},
      {t: 'start', viewW: 1280, viewH: 720, config: cfg},
      {t: 'settings', settings: {battles: 5}},
      {t: 'chat', text: 'hi'},
    ]);
  });

  it('forwards in-game messages to onGameMessage and flips to playing', async () => {
    const seen: ServerMessage[] = [];
    const {client, transports} = harness({onGameMessage: (m: ServerMessage) => seen.push(m)});
    await client.create();
    const t = transports[0];
    t.setStatus('open');

    t.recv({t: 'startGame', seed: 42, order: [1, 2]});
    t.recv({t: 'turnBegin', playerIdx: 0, deadline: 0});
    expect(client.getState().phase).toBe('playing');
    expect(seen.map(m => m.t)).toEqual(['startGame', 'turnBegin']);
  });
});
