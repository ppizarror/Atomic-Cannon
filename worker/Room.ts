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
  type MatchConfig,
  type ShotResult,
  parseClientMessage,
  isValidShotResult,
  isValidGameCommand,
  sanitizeMatchConfig,
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
  /** A late joiner who is watching, not playing: never in `order`, never gets a turn, and never
   *  counts toward the playable population (start/min/end checks). Can chat and reconnect. */
  spectator?: boolean;
}

/** Max spectators who may watch one in-progress match (separate from the player cap). */
const MAX_SPECTATORS = 8;

/** Server-side AFK backstop: if the active player takes no action within this window, a Durable-Object
 *  alarm force-advances the turn so a connected-but-idle player can't stall the room forever. Generous
 *  — it's a stall guard, not the gameplay shot clock (which is client-side and much shorter). */
const TURN_DEADLINE_MS = 120_000;

/** Server-side per-socket inbound cap. The client enforces its own (MAX_MSG_PER_SEC=200), but a
 *  hostile client bypasses that — so the DO, the one place a peer can't route around, caps too.
 *  Generous (above the client cap) so legit bursts pass; a real flood is dropped before it's parsed
 *  or amplified across every socket. */
const SERVER_MAX_MSG_PER_SEC = 300;

interface RoomState {
  code: string;
  phase: 'lobby' | 'playing' | 'ended';
  nextId: number;
  hostId: number | null;
  settings: RoomSettings;
  players: Record<number, StoredPlayer>;
  seed: number;
  order: number[];
  turnIdx: number;
  /** Wall-clock time (epoch ms) the current turn forfeits if the active player never acts; 0 when
   *  not in a live turn. Backs the DO alarm — see {@link TURN_DEADLINE_MS} and `alarm`. */
  turnDeadline: number;
  /** The host's logical resolution — the shared world size every client builds at. */
  viewW: number;
  viewH: number;
  /** The host's gameplay config, captured at Start and replayed on reconnect. */
  config: MatchConfig | null;
  /** War length (Deathmatch): number of battles. `currentBattle` is 1-based. */
  totalBattles: number;
  currentBattle: number;
  /** Tanks per player, captured at Start — turns cycle over ALL tanks (order.length × this). */
  tanksPerTeam: number;
  /** Interleave team turns (captured at Start): turn POSITION → tank index via Room.tankAt. */
  alternateTurns: boolean;
  /** Latest authoritative game state — replayed to a reconnecting/late-joining client. */
  snapshot: ShotResult | null;
  /** State hash of `snapshot` (so a resync target carries its drift-check hash). */
  snapshotHash: number;
  /** App build version of the room (first player's) — all players must match. */
  appVersion: string | null;
  /** A client reported a lockstep divergence (cheat/desync) at some point this match. Sticky —
   *  once set, every current and future (reconnect/spectator) client is flagged, so a cheating
   *  actor's stored snapshot can't silently poison a late joiner without the warning showing. */
  contested: boolean;
  /** Monotonic turn-generation counter, bumped on every turnBegin and echoed by the actor's
   *  shotResult. A stale/duplicate result carries an old gen and is rejected — so a resent or
   *  hostile-repeat result can't be re-consumed to skip a squad tank's turn or a whole battle. */
  turnGen: number;
  /** Column count (heightmap length) of the FIRST accepted snapshot this match — the world width is
   *  fixed at Start, so every later snapshot must match (a wrong-width map would build mismatched
   *  terrain on any bootstrapping client). 0 until the first snapshot pins it. */
  expectedColumns: number;
}

interface Attachment {
  playerId: number | null;
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
    turnDeadline: 0,
    viewW: 1280,
    viewH: 720,
    config: null,
    totalBattles: 1,
    currentBattle: 1,
    tanksPerTeam: 1,
    alternateTurns: false,
    snapshot: null,
    snapshotHash: 0,
    appVersion: null,
    contested: false,
    turnGen: 0,
    expectedColumns: 0,
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

  /** Per-socket inbound-message counters for the current 1s window (in-memory — a hibernated DO isn't
   *  under flood, and wakes with a fresh window). Cleared per socket on close. */
  private readonly m_rate = new Map<WebSocket, {n: number; t: number}>();

  /** True if `ws` has exceeded SERVER_MAX_MSG_PER_SEC this second — checked before parse/load so a
   *  flood is dropped cheaply. (Workers' Date.now advances on the I/O between DO invocations.) */
  private overRate(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.m_rate.get(ws);
    if (!r || now - r.t >= 1000) {
      this.m_rate.set(ws, {n: 1, t: now});
      return false;
    }
    r.n++;
    return r.n > SERVER_MAX_MSG_PER_SEC;
  }

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
      spectator: p.spectator,
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
    // Drop a flooding socket's frame before it's parsed / loads storage / is re-broadcast to peers.
    if (this.overRate(ws)) return;
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    // Cap frame size (the biggest legit message is a shotResult with a full 5-screen
    // heightmap, ~30 KB of JSON) so a client can't flood the room with huge payloads.
    if (text.length > 128 * 1024) {
      return this.send(ws, {t: 'error', code: 'bad_message', message: 'message too large'});
    }
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
      case 'config':
        return this.onConfig(s, att.playerId!, msg.config);
      case 'start':
        return this.onStart(s, att.playerId!, msg.viewW, msg.viewH, msg.config);
      case 'cmd':
        return this.onCmd(s, att.playerId!, msg);
      case 'shotResult':
        return this.onShotResult(s, att.playerId!, msg);
      case 'chat':
        return this.onChat(att.playerId!, msg.text);
      case 'desync':
        return this.onDesync(s, att.playerId!, msg.localHash, msg.keyframeHash);
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
    // A room is single-version: once the first player sets it, everyone must match so
    // the (client-authoritative) game logic agrees. Mismatch → reload for the new build.
    if (s.appVersion && msg.app !== s.appVersion) {
      return this.send(ws, {
        t: 'error',
        code: 'version_mismatch',
        message: `this room runs game v${s.appVersion} — reload to update`,
      });
    }

    // Reconnect: a valid token rebinds an existing (typically dropped) slot.
    if (msg.reconnect) {
      const existing = Object.values(s.players).find(p => p.token === msg.reconnect);
      if (existing) {
        // Evict any socket still bound to this player before rebinding — a flapping reconnect or a
        // double-opened tab can leave TWO live sockets for one id, and the stale one's later close
        // would then flip this now-live player to disconnected (and possibly end the match).
        for (const old of this.ctx.getWebSockets()) {
          if (
            old !== ws &&
            (old.deserializeAttachment() as Attachment | null)?.playerId === existing.id
          ) {
            try {
              // Unbind the evicted socket FIRST so its (async) close can't be mistaken for the live
              // player still holding a socket, nor mask a genuine disconnect of the new one.
              old.serializeAttachment({playerId: null} satisfies Attachment);
              old.close(4000, 'superseded');
            } catch {
              /* already gone */
            }
          }
        }
        existing.connected = true;
        ws.serializeAttachment({playerId: existing.id} satisfies Attachment);
        await this.save(s);
        this.send(ws, this.welcomeFor(s, existing));
        this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
        // Resume an in-progress (or finished) match: reboot from the seed, apply the
        // latest authoritative state, then hand them the current turn / final result.
        this.resumeMatch(ws, s);
        return;
      }
    }

    // A new joiner (no reconnect token) once the match is underway comes in as a SPECTATOR — they
    // watch the deterministic sim but never take a slot in the turn order.
    if (s.phase !== 'lobby') {
      const specSlots = Object.values(s.players).filter(p => p.spectator);
      // Cap on CONNECTED spectators — a disconnected one keeps its slot for token reconnect but never
      // wedges the room at `room_full`.
      if (specSlots.filter(p => p.connected).length >= MAX_SPECTATORS) {
        return this.send(ws, {t: 'error', code: 'room_full', message: 'no spectator slots left'});
      }
      // Bound total spectator slots: reap the OLDEST disconnected spectators over the budget, so a
      // join/drop spammer can't grow the roster unboundedly while the newest keep their reconnect slot.
      const stale = specSlots.filter(p => !p.connected).sort((a, b) => a.id - b.id);
      let over = specSlots.length + 1 - MAX_SPECTATORS; // +1 for the joiner about to be added
      for (const d of stale) {
        if (over <= 0) break;
        delete s.players[d.id];
        over--;
      }
      const sid = s.nextId++;
      const spec: StoredPlayer = {
        id: sid,
        name: (msg.name || `Spectator ${sid}`).slice(0, 24),
        color: msg.color ?? '#cccccc',
        ready: true,
        token: crypto.randomUUID(),
        connected: true,
        isHost: false,
        spectator: true,
      };
      s.players[sid] = spec;
      ws.serializeAttachment({playerId: sid} satisfies Attachment);
      await this.save(s);
      this.send(ws, this.welcomeFor(s, spec));
      this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
      this.resumeMatch(ws, s); // boot them to the current state + turn (as an observer)
      return;
    }
    if (Object.keys(s.players).length >= s.settings.maxPlayers) {
      return this.send(ws, {t: 'error', code: 'room_full', message: 'room is full'});
    }

    const id = s.nextId++;
    const isHost = s.hostId === null;
    if (isHost) {
      s.hostId = id;
      s.appVersion = msg.app; // first player fixes the room's version
    }
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

  /** Replay the match to one (re)joining socket: boot → latest state → turn/result. */
  private resumeMatch(ws: WebSocket, s: RoomState): void {
    if (s.phase !== 'playing' && s.phase !== 'ended') return;
    this.send(ws, {
      t: 'startGame',
      seed: s.seed,
      order: s.order,
      wind: s.settings.wind,
      mapSize: s.settings.mapSize,
      battles: s.totalBattles,
      tanksPerTeam: s.tanksPerTeam,
      currentBattle: s.currentBattle,
      viewW: s.viewW,
      viewH: s.viewH,
      config: s.config ?? sanitizeMatchConfig(),
    });
    if (s.snapshot) {
      this.send(ws, {t: 'stateUpdate', from: 0, seq: 0, result: s.snapshot, hash: s.snapshotHash});
    }
    if (s.phase === 'ended') this.send(ws, {t: 'gameOver'});
    else {
      // A (re)joiner mid-turn gets the REMAINING budget, not a fresh one — the server's alarm still
      // owns the real forfeit time, so don't re-arm it here.
      const remaining = s.turnDeadline ? Math.max(0, s.turnDeadline - Date.now()) : 0;
      this.send(ws, {
        t: 'turnBegin',
        playerIdx: Room.tankAt(s, s.turnIdx),
        deadline: remaining,
        turnGen: s.turnGen,
      });
    }
    // A contested match: warn the (re)joiner too, since their bootstrap snapshot came from a state
    // some client already flagged as divergent.
    if (s.contested) this.send(ws, {t: 'desyncFlag'});
  }

  private welcomeFor(s: RoomState, p: StoredPlayer): ServerMessage {
    return {
      t: 'welcome',
      you: p.id,
      code: s.code,
      players: Room.publicPlayers(s),
      settings: s.settings,
      config: s.config,
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
      wind: clampInt(patch.wind ?? s.settings.wind, 0, 2),
      mapSize: clampInt(patch.mapSize ?? s.settings.mapSize, 1, 5),
      tanksPerTeam: clampInt(patch.tanksPerTeam ?? s.settings.tanksPerTeam, 1, 4),
      alternateTurns: patch.alternateTurns ?? s.settings.alternateTurns,
    };
    s.settings = next;
    await this.save(s);
    this.broadcast({t: 'settings', settings: next});
  }

  /** Host publishes its gameplay config to the lobby (sanitized) so joiners can see the match
   *  settings before Start. Stored + broadcast; the same config is re-sent at Start. */
  private async onConfig(s: RoomState, pid: number, config: MatchConfig): Promise<void> {
    if (s.hostId !== pid) return;
    s.config = sanitizeMatchConfig(config);
    await this.save(s);
    this.broadcast({t: 'config', config: s.config});
  }

  private async onStart(
    s: RoomState,
    pid: number,
    viewW: number,
    viewH: number,
    config: MatchConfig,
  ): Promise<void> {
    const host = this.socketFor(pid);
    if (s.hostId !== pid) {
      if (host) this.send(host, {t: 'error', code: 'not_host', message: 'only the host can start'});
      return;
    }
    // A start is only valid from the lobby — never mid-match or after game over. Without this a host
    // (or a client spoofing `start`) could re-roll the seed and yank every client into a fresh world
    // mid-turn.
    if (s.phase !== 'lobby') {
      if (host)
        this.send(host, {t: 'error', code: 'game_in_progress', message: 'match already started'});
      return;
    }
    const connected = Object.values(s.players).filter(p => p.connected);
    if (connected.length < s.settings.minPlayers) {
      // Tell the host WHY nothing happened (the other guards in this method report; this one didn't).
      if (host)
        this.send(host, {
          t: 'error',
          code: 'not_enough_players',
          message: 'need more players to start',
        });
      return;
    }

    s.phase = 'playing';
    s.seed = newSeed();
    s.order = connected.map(p => p.id);
    s.turnIdx = 0;
    s.expectedColumns = 0; // re-pin the heightmap width on this match's first snapshot (a room can rematch)
    // The host's resolution becomes the shared world size (clamped to a sane range).
    s.viewW = clampInt(viewW, 320, 4096);
    s.viewH = clampInt(viewH, 240, 4096);
    // The host's gameplay config becomes the shared config (sanitized), applied on every client.
    s.config = sanitizeMatchConfig(config);
    // War length: a Deathmatch runs `battles` battles; Rounds/Points is always a single battle.
    s.totalBattles = s.config.gameType === 1 ? clampInt(s.settings.battles, 1, 20) : 1;
    s.currentBattle = 1;
    // Squad size: turns now cycle over ALL tanks (order.length × tanksPerTeam). Cap the total at
    // the client's MAX_TANKS (16) so no client truncates its squads — otherwise the server's tank
    // count would exceed the client's and the turn/snapshot indices would mismatch.
    const maxSquad = Math.max(1, Math.floor(16 / s.order.length));
    s.tanksPerTeam = Math.min(clampInt(s.settings.tanksPerTeam, 1, 4), maxSquad);
    s.alternateTurns = !!s.settings.alternateTurns; // interleave teams vs contiguous squads
    const deadline = await this.armTurn(s); // start the AFK backstop for the first turn
    await this.save(s);

    this.broadcast({
      t: 'startGame',
      seed: s.seed,
      order: s.order,
      wind: s.settings.wind,
      mapSize: s.settings.mapSize,
      battles: s.totalBattles,
      tanksPerTeam: s.tanksPerTeam,
      currentBattle: s.currentBattle,
      viewW: s.viewW,
      viewH: s.viewH,
      config: s.config,
    });
    this.broadcast({
      t: 'turnBegin',
      playerIdx: Room.tankAt(s, s.turnIdx),
      deadline,
      turnGen: s.turnGen,
    });
  }

  /** Total tanks in play = one squad per player. Turns cycle over POSITIONS [0, total). */
  private static totalTanks(s: RoomState): number {
    return s.order.length * s.tanksPerTeam;
  }

  /** In Deathmatch, is the battle actually decided? — ≤1 team has a living tank. Team of tank i is
   *  floor(i / tanksPerTeam): squads are contiguous and net snapshots carry NO sentries (the tank
   *  count is fixed at order.length × tanksPerTeam and isValidShotResult enforces it). */
  private static battleDecided(s: RoomState, snap: ShotResult): boolean {
    const per = Math.max(1, s.tanksPerTeam);
    const teams = new Set<number>();
    snap.tanks.forEach((t, i) => {
      if (t.alive) teams.add(Math.floor(i / per));
    });
    return teams.size <= 1;
  }

  /** The TANK INDEX active at turn-order position `pos`. Contiguous by default (identity: pos IS
   *  the tank index — player p owns [p·tanksPerTeam,…]). Alternate Turns interleaves by player so
   *  positions cycle A1,B1,A2,B2. Tank indices (snapshot/turnBegin) are always the real index. */
  private static tankAt(s: RoomState, pos: number): number {
    if (!s.alternateTurns) return pos;
    const players = s.order.length;
    return (pos % players) * s.tanksPerTeam + Math.floor(pos / players);
  }

  /** The player id that OWNS the tank at turn-order position `pos`. Turn validation checks the
   *  sender owns the active tank. */
  private static ownerOf(s: RoomState, pos: number): number | undefined {
    return s.order[Math.floor(Room.tankAt(s, pos) / s.tanksPerTeam)];
  }

  private onCmd(s: RoomState, pid: number, msg: Extract<ClientMessage, {t: 'cmd'}>): void {
    if (s.phase !== 'playing' || Room.ownerOf(s, s.turnIdx) !== pid) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'not_your_turn', message: 'not your turn'});
      return;
    }
    // Validate the command shape before relaying — a malformed cmd (null, unknown type, non-finite
    // index/coords) would crash or NaN-corrupt every peer's applyCommand.
    if (!isValidGameCommand(msg.cmd)) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'bad_message', message: 'invalid command'});
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
    if (s.phase !== 'playing' || Room.ownerOf(s, s.turnIdx) !== pid) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'not_your_turn', message: 'not your turn'});
      return;
    }
    // Idempotency: turnGen is the ONLY duplicate signal we can trust. Every live client echoes the
    // gen from the turnBegin that opened its turn (see NetGame), so require it — a result that omits
    // it (a crafted bypass, since seq is fully client-controlled and unvalidated) is rejected rather
    // than trusted. Then drop any result whose gen isn't the live turn's: a resend or hostile repeat
    // carries a stale gen, and re-consuming it would let the owner (who still owns the NEXT turn in a
    // contiguous squad) skip tank-1's turn and double the hand-off income, or advance the battle twice
    // after `over`. Silent drop for a stale gen — not an error; a missing gen is a malformed message.
    if (typeof msg.turnGen !== 'number') {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'bad_message', message: 'missing turn generation'});
      return;
    }
    if (msg.turnGen !== s.turnGen) return;
    // Validate the authoritative result STRUCTURALLY before persisting/broadcasting it. A malformed
    // result (null/short tank array, non-finite fields, bad heightmap) would otherwise be stored as
    // the room snapshot and crash — or NaN-corrupt — every client that later bootstraps from it (a
    // reconnect or a new spectator), permanently bricking the room across DO hibernation. Reject it;
    // the turn stays put and the AFK alarm forfeits it if the actor never sends a valid result.
    if (!isValidShotResult(msg.result, Room.totalTanks(s))) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'bad_message', message: 'invalid shot result'});
      return;
    }
    // The world width is fixed for the whole match — pin the heightmap column count on the first
    // snapshot and reject any later result of a different width (it would build a mismatched terrain
    // on any client that bootstraps from it).
    if (s.expectedColumns === 0) s.expectedColumns = msg.result.heights.length;
    else if (msg.result.heights.length !== s.expectedColumns) {
      const ws = this.socketFor(pid);
      if (ws) this.send(ws, {t: 'error', code: 'bad_message', message: 'heightmap width changed'});
      return;
    }
    // Broadcast the authoritative outcome + its hash, and keep both for reconnects.
    s.snapshot = msg.result;
    s.snapshotHash = msg.hash;
    this.broadcast({t: 'stateUpdate', from: pid, seq: msg.seq, result: msg.result, hash: msg.hash});

    // Honour a battle-end claim only if the snapshot bears it out — in Deathmatch, ≤1 team with a
    // living tank. A hostile/buggy actor can't end a battle (or cycle seeds / reach gameOver) early;
    // an unfounded `over` falls through to a normal turn advance. Rounds ends on the round count (the
    // server doesn't track it), so trust `over` there.
    const overIsLegit =
      !!msg.over && (!s.config || s.config.gameType !== 1 || Room.battleDecided(s, msg.result));
    if (overIsLegit) {
      // The acting client says this BATTLE ended. If the war has more battles, advance to a
      // fresh one (new seed → new terrain, everyone respawns); otherwise the war is over.
      if (s.currentBattle < s.totalBattles) {
        s.currentBattle++;
        s.seed = newSeed(); // fresh terrain for the new battle (identical on every client)
        // Drop the previous battle's authoritative state FIRST — it belongs to terrain that no longer
        // exists (a reconnecter before the new battle's first shot would otherwise get the old
        // heightmap + dead-tank positions), AND its dead-tank life would wrongly mark respawned tanks
        // unplayable in firstLivingTurn below.
        s.snapshot = null;
        s.snapshotHash = 0;
        // A divergence flag tied to the now-discarded terrain no longer applies — clear it so it stops
        // warning every joiner for the rest of the war (resumeMatch re-emits desyncFlag while set).
        s.contested = false;
        // Open the new battle on the first CONNECTED player (all tanks respawn alive), NOT blindly
        // position 0 — if order[0] dropped during the previous battle, a blind 0 would hand the turn
        // to a gone player and stall the whole battle until the ~120s AFK alarm skips it.
        s.turnIdx = this.firstLivingTurn(s);
        const nbDeadline = await this.armTurn(s); // fresh battle → arm the first turn's backstop
        await this.save(s);
        // Clients show the battle-winner celebration, then advance on this message; the turn
        // hand-off is queued behind that intermission (see NetGame). Order is unchanged.
        this.broadcast({t: 'nextBattle', battle: s.currentBattle, seed: s.seed});
        this.broadcast({
          t: 'turnBegin',
          playerIdx: Room.tankAt(s, s.turnIdx),
          deadline: nbDeadline,
          turnGen: s.turnGen,
        });
        return;
      }
      // War over — stop here and show the final standings.
      s.phase = 'ended';
      await this.disarmTurn(s); // no more turns → cancel the AFK backstop
      await this.save(s);
      this.broadcast({t: 'gameOver'});
      return;
    }

    const prevIdx = s.turnIdx;
    s.turnIdx = this.nextLivingTurn(s);
    const roundWrapped = s.turnIdx <= prevIdx; // advanced past the last player → a round completed
    const deadline = await this.armTurn(s); // reset the AFK backstop for the new turn
    await this.save(s);
    // handoff:true → this turn follows a shot, so clients run the once-per-turn effects (crate
    // roll + income). The match/battle's first turnBegin (onStart/nextBattle) omits it.
    this.broadcast({
      t: 'turnBegin',
      playerIdx: Room.tankAt(s, s.turnIdx),
      deadline,
      handoff: true,
      roundWrapped,
      turnGen: s.turnGen,
    });
  }

  /** Advance to the next turn, skipping players whose tank is DEAD (life ≤ 0) or whose socket
   *  is DISCONNECTED — a dropped player must never hold the turn, or the match stalls. */
  /** Can turn POSITION `pos` take a turn? Its owner must be present+connected, and in Deathmatch its
   *  tank must still be alive (Rounds/Point is non-lethal — a 0-life tank keeps playing). */
  private playablePos(s: RoomState, pos: number): boolean {
    const owner = Room.ownerOf(s, pos);
    const p = owner === undefined ? undefined : s.players[owner];
    if (!p || !p.connected) return false; // owner dropped → skip
    if (s.config && s.config.gameType !== 1) return true;
    const tankIdx = Room.tankAt(s, pos);
    return s.snapshot ? (s.snapshot.tanks[tankIdx]?.life ?? 1) > 0 : true; // dead tank → skip
  }

  private nextLivingTurn(s: RoomState): number {
    const n = Room.totalTanks(s); // cycle over turn POSITIONS (one per tank)
    if (n === 0) return 0;
    let pos = s.turnIdx;
    for (let step = 0; step < n; step++) {
      pos = (pos + 1) % n;
      if (this.playablePos(s, pos)) return pos;
    }
    return (s.turnIdx + 1) % n; // no one playable (shouldn't happen — <2-connected ends the game)
  }

  /** The first playable turn POSITION scanning from 0 INCLUSIVE — used to open a fresh battle. Unlike
   *  nextLivingTurn (which starts at turnIdx+1), this can land ON position 0. Prevents a new battle
   *  from being handed to a since-dropped order[0] (a 120s AFK-alarm stall until it self-heals). */
  private firstLivingTurn(s: RoomState): number {
    const n = Room.totalTanks(s);
    for (let pos = 0; pos < n; pos++) if (this.playablePos(s, pos)) return pos;
    return 0;
  }

  /** Arm the AFK backstop for the turn that's about to begin: record its wall-clock forfeit time on
   *  the state and (re)schedule the DO alarm at that instant. Setting a new alarm replaces any pending
   *  one, so a shot/hand-off that opens the next turn automatically cancels the old turn's deadline.
   *  Returns the ms budget to advertise to clients in `turnBegin` (0 = no limit). */
  private async armTurn(s: RoomState): Promise<number> {
    s.turnGen++; // a NEW turn is opening — bump the generation the actor must echo in its shotResult
    s.turnDeadline = Date.now() + TURN_DEADLINE_MS;
    await this.ctx.storage.setAlarm(s.turnDeadline);
    return TURN_DEADLINE_MS;
  }

  /** Cancel the AFK backstop — the match is over, so no turn can forfeit. */
  private async disarmTurn(s: RoomState): Promise<void> {
    s.turnDeadline = 0;
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * DO alarm: the active player's turn deadline elapsed. If they still haven't acted, FORFEIT the
   * turn — advance to the next living player and open their turn. No shot was fired, so the shared
   * deterministic sim state is unchanged; clients just move the turn pointer (with the usual
   * once-per-turn hand-off effects). If a newer turn already pushed the deadline out (a shot landed
   * just before the alarm), re-arm for the remaining time instead of forfeiting.
   */
  async alarm(): Promise<void> {
    const s = await this.load();
    if (s.phase !== 'playing' || !s.turnDeadline) return; // not in a live turn → nothing to forfeit
    if (Date.now() < s.turnDeadline - 50) {
      await this.ctx.storage.setAlarm(s.turnDeadline); // a later turn moved it out → re-arm, don't forfeit
      return;
    }
    const prevIdx = s.turnIdx;
    s.turnIdx = this.nextLivingTurn(s);
    const roundWrapped = s.turnIdx <= prevIdx; // advanced past the last player → a round completed
    const deadline = await this.armTurn(s);
    await this.save(s);
    // handoff:true → the forfeited turn still passes, so clients run per-turn income + the crate roll
    // (deterministic on every client). roundWrapped awards per-round income when the order wraps.
    this.broadcast({
      t: 'turnBegin',
      playerIdx: Room.tankAt(s, s.turnIdx),
      deadline,
      handoff: true,
      roundWrapped,
      turnGen: s.turnGen,
    });
  }

  private onChat(pid: number, text: string): void {
    const clean = text.slice(0, 200);
    if (clean) this.broadcast({t: 'chat', from: pid, text: clean});
  }

  /** A client's deterministic result disagreed with the acting client's keyframe. In true lockstep
   *  the reporter keeps its own (trusted) state, so we don't overwrite anything server-side — we log
   *  the divergence so a cheating/desyncing match is visible to the operator. (No auto-resolution:
   *  in a 2-player game there's no majority to arbitrate; this is detection, not correction.) */
  private async onDesync(
    s: RoomState,
    pid: number,
    localHash: number,
    keyframeHash: number,
  ): Promise<void> {
    console.warn(
      `[desync] room=${s.code} reporter=${pid} turnActor=${Room.ownerOf(s, s.turnIdx)} ` +
        `localHash=${localHash} keyframeHash=${keyframeHash}`,
    );
    // Flag the whole room (once). Every present client — and any future reconnect/spectator (see
    // resumeMatch) — is told the state is contested, so a cheating actor can't quietly poison a
    // late joiner's bootstrap without the warning appearing everywhere.
    if (!s.contested) {
      s.contested = true;
      await this.save(s);
      this.broadcast({t: 'desyncFlag'});
    }
  }

  private async onLeave(ws: WebSocket, s: RoomState, pid: number): Promise<void> {
    // dropPlayer handles the mid-match consequences (end if <2 remain, or hand off the turn
    // if the leaver held it). An explicit leave frees the slot even mid-match.
    await this.dropPlayer(s, pid, /*removeSlot=*/ true);
    try {
      ws.close(1000, 'left');
    } catch {
      /* ignore */
    }
  }

  /** Connected PLAYABLE players (spectators excluded) — drives the "<2 left → end the match" rule. */
  private connectedCount(s: RoomState): number {
    return Object.values(s.players).filter(p => p.connected && !p.spectator).length;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.m_rate.delete(ws); // drop this socket's rate-limit counter
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.playerId == null) return;
    // If another socket is STILL bound to this player (a superseded reconnect socket closing late),
    // this close is stale — the player is live on the newer socket, so it must not drop them.
    for (const other of this.ctx.getWebSockets()) {
      if (
        other !== ws &&
        (other.deserializeAttachment() as Attachment | null)?.playerId === att.playerId
      ) {
        return;
      }
    }
    const s = await this.load();
    // In-lobby drops free the slot; in-game drops (players AND spectators) keep it so a token
    // reconnect can resume. Disconnected spectators don't count toward the cap and are reaped
    // oldest-first if they pile up past the budget (see the spectator-join path in onHello).
    await this.dropPlayer(s, att.playerId, /*removeSlot=*/ s.phase === 'lobby');
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  private async dropPlayer(s: RoomState, pid: number, removeSlot: boolean): Promise<void> {
    const p = s.players[pid];
    if (!p) return;
    if (!removeSlot && !p.connected) return; // already dropped (e.g. leave → ws.close double-fires)
    // Did the departing player hold the current turn? (Check before mutating the roster.)
    const wasActive = s.phase === 'playing' && Room.ownerOf(s, s.turnIdx) === pid;
    if (removeSlot) delete s.players[pid];
    else p.connected = false;

    // Reassign host if the host left — to another PLAYER, never a spectator.
    if (s.hostId === pid) {
      const next = Object.values(s.players).find(q => q.connected && !q.spectator);
      s.hostId = next?.id ?? null;
      for (const q of Object.values(s.players)) q.isHost = q.id === s.hostId;
    }

    // Mid-match consequences: end the game if fewer than two players are connected (the last
    // one sees the result instead of waiting forever), otherwise hand the turn off if the
    // departed player was holding it — a dropped active player would otherwise stall the match.
    if (s.phase === 'playing') {
      if (this.connectedCount(s) < 2) {
        s.phase = 'ended';
        await this.disarmTurn(s); // match over → cancel the AFK backstop
        await this.save(s);
        this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
        this.broadcast({t: 'gameOver'});
        return;
      }
      if (wasActive) {
        s.turnIdx = this.nextLivingTurn(s);
        const deadline = await this.armTurn(s); // the leaver held the turn → arm the successor's
        await this.save(s);
        this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
        this.broadcast({
          t: 'turnBegin',
          playerIdx: Room.tankAt(s, s.turnIdx),
          deadline,
          turnGen: s.turnGen,
        });
        return;
      }
    }
    await this.save(s);
    this.broadcast({t: 'roster', players: Room.publicPlayers(s)});
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
