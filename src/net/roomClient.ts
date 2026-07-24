/**
 * RoomClient — the glue between a {@link NetTransport} and the game/UI. It owns
 * the connection lifecycle (mint-or-join a code, connect, say hello, resume on
 * reconnect), tracks lobby state (roster, settings, who you are, host flag), and
 * forwards in-game messages to a consumer.
 *
 * It's transport-agnostic: pass any `transportFactory`. The default connects a
 * `WebSocketTransport` to `/room/<CODE>` on the current origin, where the Worker
 * routes it to the room's Durable Object.
 */
import {
  type ClientMessage,
  type ServerMessage,
  type PlayerInfo,
  type RoomSettings,
  type MatchConfig,
  type ErrorCode,
  PROTOCOL_VERSION,
} from './protocol';
import {WebSocketTransport, type NetTransport, type ConnStatus} from './transport';

export type RoomPhase = 'idle' | 'connecting' | 'lobby' | 'playing' | 'closed' | 'error';

export interface RoomIdentity {
  name: string;
  color?: string;
}

/** The snapshot the UI renders from. */
export interface RoomClientState {
  phase: RoomPhase;
  status: ConnStatus;
  code: string;
  youId: number | null;
  players: readonly PlayerInfo[];
  settings: RoomSettings;
  /** The host's gameplay config (null until the host publishes it), shown in the lobby. */
  config: MatchConfig | null;
  isHost: boolean;
  lastError: {code: ErrorCode; message: string} | null;
}

export interface RoomClientOptions {
  identity: RoomIdentity;
  /** App build version, sent on hello so a room stays single-version. */
  appVersion: string;
  /** Build a transport for a room URL (default: WebSocketTransport). */
  transportFactory?: (url: string) => NetTransport;
  /** Mint a fresh room code (default: GET /api/new). */
  mintCode?: () => Promise<string>;
  /** Origin for URL building (default: location.origin). */
  origin?: string;
  /** Notified on every lobby-state change. */
  onState?: (s: RoomClientState) => void;
  /** In-game messages (startGame / turnBegin / cmd / stateUpdate / chat). */
  onGameMessage?: (msg: ServerMessage) => void;
}

const DEFAULT_SETTINGS: RoomSettings = {
  maxPlayers: 6,
  minPlayers: 2,
  battles: 2,
  wind: 1,
  mapSize: 2,
  tanksPerTeam: 1,
  alternateTurns: false,
};

/** ws(s):// URL for a room code on a given http(s) origin. */
export function roomUrl(origin: string, code: string): string {
  const ws = origin.replace(/^http/, 'ws');
  return `${ws}/room/${encodeURIComponent(code)}`;
}

export class RoomClient {
  private m_transport: NetTransport | null = null;
  private m_reconnectToken: string | null = null;
  private m_state: RoomClientState = {
    phase: 'idle',
    status: 'idle',
    code: '',
    youId: null,
    players: [],
    settings: {...DEFAULT_SETTINGS},
    config: null,
    isHost: false,
    lastError: null,
  };

  constructor(private readonly opts: RoomClientOptions) {}

  getState(): RoomClientState {
    return this.m_state;
  }

  /** Create a brand-new room (mint a code, then connect). Returns the code. */
  async create(): Promise<string> {
    const code = await (this.opts.mintCode ?? defaultMintCode(this.origin()))();
    this.connect(code);
    return code;
  }

  /** Join an existing room by code. */
  join(code: string): void {
    this.connect(code);
  }

  private origin(): string {
    return this.opts.origin ?? globalThis.location?.origin ?? '';
  }

  private connect(code: string): void {
    this.close(); // drop any prior connection
    this.m_reconnectToken = null;
    this.patch({phase: 'connecting', code, lastError: null, youId: null, players: []});

    const url = roomUrl(this.origin(), code);
    const factory = this.opts.transportFactory ?? ((u: string) => new WebSocketTransport({url: u}));
    const t = factory(url);
    this.m_transport = t;

    t.onStatus(s => this.onStatus(s));
    t.onMessage(m => this.onMessage(m));
    t.connect();
  }

  private onStatus(status: ConnStatus): void {
    this.patch({status});
    // (Re)identify whenever the socket opens — the same path handles first
    // connect and reconnect (the token resumes an existing slot).
    if (status === 'open') {
      const hello: ClientMessage = {
        t: 'hello',
        v: PROTOCOL_VERSION,
        app: this.opts.appVersion,
        name: this.opts.identity.name,
        color: this.opts.identity.color,
        reconnect: this.m_reconnectToken ?? undefined,
      };
      this.m_transport?.send(hello);
    } else if (status === 'closed' && this.m_state.phase !== 'error') {
      this.patch({phase: 'closed'});
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.m_reconnectToken = msg.reconnect;
        this.patch({
          phase: 'lobby',
          code: msg.code || this.m_state.code,
          youId: msg.you,
          players: msg.players,
          settings: msg.settings,
          config: msg.config,
          isHost: hostOf(msg.players) === msg.you,
        });
        return;
      case 'roster':
        this.patch({
          players: msg.players,
          isHost: this.m_state.youId != null && hostOf(msg.players) === this.m_state.youId,
        });
        return;
      case 'settings':
        this.patch({settings: msg.settings});
        return;
      case 'config':
        this.patch({config: msg.config});
        return;
      case 'error':
        this.patch({phase: 'error', lastError: {code: msg.code, message: msg.message}});
        this.opts.onState?.(this.m_state);
        return;
      case 'kick':
      case 'quit':
        this.patch({phase: 'closed'});
        this.close();
        return;
      case 'startGame':
        this.patch({phase: 'playing'});
        this.opts.onGameMessage?.(msg);
        return;
      case 'turnBegin':
      case 'cmd':
      case 'stateUpdate':
      case 'chat':
        this.opts.onGameMessage?.(msg);
        return;
    }
  }

  // ── outbound (UI actions) ─────────────────────────────────────────────────
  setReady(ready: boolean): void {
    this.send({t: 'ready', ready});
  }
  startMatch(viewW: number, viewH: number, config: MatchConfig): void {
    this.send({t: 'start', viewW, viewH, config});
  }
  updateSettings(settings: Partial<RoomSettings>): void {
    this.send({t: 'settings', settings});
  }
  /** Host: publish this machine's gameplay config so the lobby can display it to everyone. */
  publishConfig(config: MatchConfig): void {
    this.send({t: 'config', config});
  }
  chat(text: string): void {
    this.send({t: 'chat', text});
  }
  /** Send a gameplay message (turn command / shot result) once playing. */
  send(msg: ClientMessage): void {
    this.m_transport?.send(msg);
  }

  leave(): void {
    this.send({t: 'leave'});
    this.close();
    this.patch({phase: 'closed'});
  }

  close(): void {
    this.m_transport?.close();
    this.m_transport = null;
  }

  private patch(next: Partial<RoomClientState>): void {
    this.m_state = {...this.m_state, ...next};
    this.opts.onState?.(this.m_state);
  }
}

/** The lowest-id connected player is the host, matching the room's own rule. */
function hostOf(players: readonly PlayerInfo[]): number | null {
  const host = players.find(p => p.isHost);
  return host ? host.id : null;
}

function defaultMintCode(origin: string): () => Promise<string> {
  return async () => {
    const res = await fetch(`${origin}/api/new`);
    if (!res.ok) throw new Error(`mint failed: ${res.status}`);
    const data = (await res.json()) as {code: string};
    return data.code;
  };
}
