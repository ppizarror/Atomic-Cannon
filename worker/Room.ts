/**
 * Room — one Durable Object per room code (the code *is* the DO name). It's the
 * authoritative turn arbiter + roster keeper + relay; it does NOT run physics
 * (the acting client simulates its own shot). Uses the WebSocket Hibernation API
 * so idle rooms — waiting on a human to aim, or between games — cost no duration.
 *
 * Because a hibernated DO loses in-memory state, the room lives in `ctx.storage`
 * and each socket is bound to its player via `serializeAttachment`.
 */
import {
  type ClientMessage,
  type ServerMessage,
  type PlayerInfo,
  type RoomSettings,
  parseClientMessage,
  PROTOCOL_VERSION,
} from '../src/net/protocol';

interface Env {
  ROOM: DurableObjectNamespace;
}

interface StoredPlayer {
  id: number;
  name: string;
  color: string;
  ready: boolean;
  token: string; // reconnect secret (never sent to other clients)
  connected: boolean;
  isHost: boolean;
}

interface RoomState {
  code: string;
  phase: 'lobby' | 'playing';
  nextId: number;
  hostId: number | null;
  settings: RoomSettings;
  players: Record<number, StoredPlayer>;
  seed: number;
  order: number[];
  turnIdx: number;
}

interface Attachment {
  playerId: number | null;
}

const DEFAULT_SETTINGS: RoomSettings = {maxPlayers: 6, minPlayers: 2, battles: 2};

function freshState(code: string): RoomState {
  return {
    code,
    phase: 'lobby',
    nextId: 1,
    hostId: null,
    settings: {...DEFAULT_SETTINGS},
    players: {},
    seed: 0,
    order: [],
    turnIdx: 0,
  };
}

/** A 32-bit non-zero seed for the match RNG. */
function newSeed(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] || 1;
}

export class Room {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  // ── HTTP: the WebSocket upgrade ────────────────────────────────────────────
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', {status: 426});
    }
    // The Worker passes the human-readable code so the DO can learn its own name.
    const code = new URL(req.url).searchParams.get('code') ?? '';
    if (code) await this.ensureState(code);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server); // hibernatable
    server.serializeAttachment({playerId: null} satisfies Attachment);
    return new Response(null, {status: 101, webSocket: client});
  }

  // ── State helpers ──────────────────────────────────────────────────────────
  private async load(): Promise<RoomState> {
    return (await this.ctx.storage.get<RoomState>('room')) ?? freshState('');
  }
  private async save(s: RoomState): Promise<void> {
    await this.ctx.storage.put('room', s);
  }
  private async ensureState(code: string): Promise<void> {
    const s = await this.load();
    if (!s.code) {
      s.code = code;
      await this.save(s);
    }
  }

  private static publicPlayers(s: RoomState): PlayerInfo[] {
    return Object.values(s.players).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      connected: p.connected,
      isHost: p.isHost,
    }));
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone; close handler will reconcile */
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(raw);
      } catch {
        /* ignore */
      }
    }
  }

  private socketFor(playerId: number): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.playerId === playerId) return ws;
    }
    return null;
  }

  // ── Message handling ────────────────────────────────────────────────────────
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const msg = parseClientMessage(text);
    if (!msg) return this.send(ws, {t: 'error', code: 'bad_message', message: 'unparseable'});

    const s = await this.load();
    const att = (ws.deserializeAttachment() as Attachment | null) ?? {playerId: null};

    // The only message allowed before identifying is hello.
    if (att.playerId === null && msg.t !== 'hello') {
      return this.send(ws, {t: 'error', code: 'bad_message', message: 'say hello first'});
    }

    switch (msg.t) {
      case 'hello':
        return this.onHello(ws, s, msg);
      case 'ready':
        return this.onReady(s, att.playerId!, msg.ready);
      case 'settings':
        return this.onSettings(s, att.playerId!, msg.settings);
      case 'start':
        return this.onStart(s, att.playerId!);
      case 'cmd':
        return this.onCmd(s, att.playerId!, msg);
      case 'shotResult':
        return this.onShotResult(s, att.playerId!, msg);
      case 'chat':
        return this.onChat(att.playerId!, msg.text);
      case 'leave':
        return this.onLeave(ws, s, att.playerId!);
    }
  }

  private async onHello(
    ws: WebSocket,
    s: RoomState,
    msg: Extract<ClientMessage, {t: 'hello'}>,
  ): Promise<void> {
    if (msg.v !== PROTOCOL_VERSION) {
      return this.send(ws, {
        t: 'error',
        code: 'version_mismatch',
        message: `server speaks protocol ${PROTOCOL_VERSION}`,
      });
    }

    // Reconnect: a valid token rebinds an existing (typically dropped) slot.
    if (msg.reconnect) {
      const existing = Object.values(s.players).find(p => p.token === msg.reconnect);
      if (existing) {
        existing.connected = true;
        ws.serializeAttachment({playerId: existing.id} satisfies Attachment);
        await this.save(s);
        this.send(ws, this.welcomeFor(s, existing));
        this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
        return;
      }
    }

    if (s.phase === 'playing') {
      return this.send(ws, {
        t: 'error',
        code: 'game_in_progress',
        message: 'match already started',
      });
    }
    if (Object.keys(s.players).length >= s.settings.maxPlayers) {
      return this.send(ws, {t: 'error', code: 'room_full', message: 'room is full'});
    }

    const id = s.nextId++;
    const isHost = s.hostId === null;
    if (isHost) s.hostId = id;
    const player: StoredPlayer = {
      id,
      name: (msg.name || `Player ${id}`).slice(0, 24),
      color: msg.color ?? '#cccccc',
      ready: false,
      token: crypto.randomUUID(),
      connected: true,
      isHost,
    };
    s.players[id] = player;
    ws.serializeAttachment({playerId: id} satisfies Attachment);
    await this.save(s);

    this.send(ws, this.welcomeFor(s, player));
    this.broadcast({t: 'roster', players: Room.publicPlayers(s)}, ws);
  }

  private welcomeFor(s: RoomState, p: StoredPlayer): ServerMessage {
    return {
      t: 'welcome',
      you: p.id,
      code: s.code,
      players: Room.publicPlayers(s),
      settings: s.settings,
      reconnect: p.token,
    };
  }

  private async onReady(s: RoomState, pid: number, ready: boolean): Promise<void> {
    const p = s.players[pid];
    if (!p) return;
    p.ready = ready;
    await this.save(s);
    this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
  }

  private async onSettings(s: RoomState, pid: number, patch: Partial<RoomSettings>): Promise<void> {
    if (s.hostId !== pid) return;
    const next: RoomSettings = {
      maxPlayers: clampInt(patch.maxPlayers ?? s.settings.maxPlayers, 2, 8),
      minPlayers: clampInt(patch.minPlayers ?? s.settings.minPlayers, 2, 8),
      battles: clampInt(patch.battles ?? s.settings.battles, 1, 20),
    };
    s.settings = next;
    await this.save(s);
    this.broadcast({t: 'settings', settings: next});
  }

  private async onStart(s: RoomState, pid: number): Promise<void> {
    const host = this.socketFor(pid);
    if (s.hostId !== pid) {
      if (host) this.send(host, {t: 'error', code: 'not_host', message: 'only the host can start'});
      return;
    }
    const connected = Object.values(s.players).filter(p => p.connected);
    if (connected.length < s.settings.minPlayers) return;

    s.phase = 'playing';
    s.seed = newSeed();
    s.order = connected.map(p => p.id);
    s.turnIdx = 0;
    await this.save(s);

    this.broadcast({t: 'startGame', seed: s.seed, order: s.order});
    this.broadcast({t: 'turnBegin', playerIdx: s.turnIdx, deadline: 0});
  }

  private onCmd(s: RoomState, pid: number, msg: Extract<ClientMessage, {t: 'cmd'}>): void {
    if (s.phase !== 'playing' || s.order[s.turnIdx] !== pid) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'not_your_turn', message: 'not your turn'});
      return;
    }
    // Relay the intent so spectators mirror the acting player's aim/inventory.
    this.broadcast(
      {t: 'cmd', from: pid, seq: msg.seq, cmd: msg.cmd},
      this.socketFor(pid) ?? undefined,
    );
  }

  private async onShotResult(
    s: RoomState,
    pid: number,
    msg: Extract<ClientMessage, {t: 'shotResult'}>,
  ): Promise<void> {
    if (s.phase !== 'playing' || s.order[s.turnIdx] !== pid) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'not_your_turn', message: 'not your turn'});
      return;
    }
    // Broadcast the authoritative outcome, then advance the turn arbiter.
    this.broadcast({t: 'stateUpdate', from: pid, seq: msg.seq, result: msg.result});
    s.turnIdx = s.order.length ? (s.turnIdx + 1) % s.order.length : 0;
    await this.save(s);
    this.broadcast({t: 'turnBegin', playerIdx: s.turnIdx, deadline: 0});
  }

  private onChat(pid: number, text: string): void {
    const clean = text.slice(0, 200);
    if (clean) this.broadcast({t: 'chat', from: pid, text: clean});
  }

  private async onLeave(ws: WebSocket, s: RoomState, pid: number): Promise<void> {
    await this.dropPlayer(s, pid, /*removeSlot=*/ s.phase === 'lobby');
    try {
      ws.close(1000, 'left');
    } catch {
      /* ignore */
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.playerId == null) return;
    const s = await this.load();
    // In-lobby drops free the slot; in-game drops keep it for reconnect.
    await this.dropPlayer(s, att.playerId, /*removeSlot=*/ s.phase === 'lobby');
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  private async dropPlayer(s: RoomState, pid: number, removeSlot: boolean): Promise<void> {
    const p = s.players[pid];
    if (!p) return;
    if (removeSlot) delete s.players[pid];
    else p.connected = false;

    // Reassign host if the host left.
    if (s.hostId === pid) {
      const next = Object.values(s.players).find(q => q.connected);
      s.hostId = next?.id ?? null;
      for (const q of Object.values(s.players)) q.isHost = q.id === s.hostId;
    }
    await this.save(s);
    this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
