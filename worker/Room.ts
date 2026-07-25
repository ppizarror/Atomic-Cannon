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
  };
}

/** Clamp the host's gameplay config into sane ranges (a bad/hostile host can't hand peers
 *  values that break their sim). Applied on Start, then broadcast + replayed identically. */
function sanitizeConfig(c: MatchConfig): MatchConfig {
  const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  return {
    hitpoints: num(c?.hitpoints, 1, 100000, 1000),
    tankSizeScale: num(c?.tankSizeScale, 0.25, 4, 1),
    explosionScale: num(c?.explosionScale, 0.25, 8, 1),
    powerScale: num(c?.powerScale, 0.25, 4, 1),
    kickbackScale: num(c?.kickbackScale, 0, 8, 1),
    buryTanks: !!c?.buryTanks,
    variance: c?.variance ?? true, // default ON (matches the game default)
    relativeTurrets: !!c?.relativeTurrets,
    utilityTurn: !!c?.utilityTurn,
    radiationDamage: c?.radiationDamage ?? true,
    crateChance: num(c?.crateChance, 0, 100, 20),
    startCredits: num(c?.startCredits, 0, 1000000, 3000),
    gameType: num(c?.gameType, 0, 1, 1) === 0 ? 0 : 1,
    sellRate: num(c?.sellRate, 0, 1, 0.5),
    creditDamage: num(c?.creditDamage, 0, 1000, 1),
    creditKill: num(c?.creditKill, 0, 100000, 500),
    creditTurn: num(c?.creditTurn, 0, 100000, 0),
    creditRound: num(c?.creditRound, 0, 100000, 1000),
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
      // Count only CONNECTED spectators toward the cap — a disconnected spectator's slot is reaped on
      // close (see webSocketClose), but count connected-only too so a burst of join/drop can never
      // wedge the room at `room_full` with ghost spectators.
      const specs = Object.values(s.players).filter(p => p.spectator && p.connected).length;
      if (specs >= MAX_SPECTATORS) {
        return this.send(ws, {t: 'error', code: 'room_full', message: 'no spectator slots left'});
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
      config: s.config ?? sanitizeConfig({} as MatchConfig),
    });
    if (s.snapshot) {
      this.send(ws, {t: 'stateUpdate', from: 0, seq: 0, result: s.snapshot, hash: s.snapshotHash});
    }
    if (s.phase === 'ended') this.send(ws, {t: 'gameOver'});
    else {
      // A (re)joiner mid-turn gets the REMAINING budget, not a fresh one — the server's alarm still
      // owns the real forfeit time, so don't re-arm it here.
      const remaining = s.turnDeadline ? Math.max(0, s.turnDeadline - Date.now()) : 0;
      this.send(ws, {t: 'turnBegin', playerIdx: Room.tankAt(s, s.turnIdx), deadline: remaining});
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
    s.config = sanitizeConfig(config);
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
    if (connected.length < s.settings.minPlayers) return;

    s.phase = 'playing';
    s.seed = newSeed();
    s.order = connected.map(p => p.id);
    s.turnIdx = 0;
    // The host's resolution becomes the shared world size (clamped to a sane range).
    s.viewW = clampInt(viewW, 320, 4096);
    s.viewH = clampInt(viewH, 240, 4096);
    // The host's gameplay config becomes the shared config (sanitized), applied on every client.
    s.config = sanitizeConfig(config);
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
    this.broadcast({t: 'turnBegin', playerIdx: Room.tankAt(s, s.turnIdx), deadline});
  }

  /** Total tanks in play = one squad per player. Turns cycle over POSITIONS [0, total). */
  private static totalTanks(s: RoomState): number {
    return s.order.length * s.tanksPerTeam;
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
    // Broadcast the authoritative outcome + its hash, and keep both for reconnects.
    s.snapshot = msg.result;
    s.snapshotHash = msg.hash;
    this.broadcast({t: 'stateUpdate', from: pid, seq: msg.seq, result: msg.result, hash: msg.hash});

    if (msg.over) {
      // The acting client says this BATTLE ended. If the war has more battles, advance to a
      // fresh one (new seed → new terrain, everyone respawns); otherwise the war is over.
      if (s.currentBattle < s.totalBattles) {
        s.currentBattle++;
        s.seed = newSeed(); // fresh terrain for the new battle (identical on every client)
        s.turnIdx = 0;
        // Drop the previous battle's authoritative state — it belongs to terrain that no longer
        // exists. Without this, a player reconnecting before the new battle's first shot would
        // have last battle's heightmap + dead-tank positions stamped over the fresh battle.
        s.snapshot = null;
        s.snapshotHash = 0;
        const nbDeadline = await this.armTurn(s); // fresh battle → arm the first turn's backstop
        await this.save(s);
        // Clients show the battle-winner celebration, then advance on this message; the turn
        // hand-off is queued behind that intermission (see NetGame). Order is unchanged.
        this.broadcast({t: 'nextBattle', battle: s.currentBattle, seed: s.seed});
        this.broadcast({
          t: 'turnBegin',
          playerIdx: Room.tankAt(s, s.turnIdx),
          deadline: nbDeadline,
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
    });
  }

  /** Advance to the next turn, skipping players whose tank is DEAD (life ≤ 0) or whose socket
   *  is DISCONNECTED — a dropped player must never hold the turn, or the match stalls. */
  private nextLivingTurn(s: RoomState): number {
    const n = Room.totalTanks(s); // cycle over turn POSITIONS (one per tank)
    if (n === 0) return 0;
    const playable = (pos: number) => {
      const owner = Room.ownerOf(s, pos);
      const p = owner === undefined ? undefined : s.players[owner];
      if (!p || !p.connected) return false; // owner dropped → skip
      // Rounds/Point (gameType 0) is non-lethal: a tank bottoms at 0 life but is never destroyed
      // and keeps taking turns. Only skip the dead in Deathmatch (gameType 1).
      if (s.config && s.config.gameType !== 1) return true;
      const tankIdx = Room.tankAt(s, pos);
      return s.snapshot ? (s.snapshot.tanks[tankIdx]?.life ?? 1) > 0 : true; // dead tank → skip
    };
    let pos = s.turnIdx;
    for (let step = 0; step < n; step++) {
      pos = (pos + 1) % n;
      if (playable(pos)) return pos;
    }
    return (s.turnIdx + 1) % n; // no one playable (shouldn't happen — <2-connected ends the game)
  }

  /** Arm the AFK backstop for the turn that's about to begin: record its wall-clock forfeit time on
   *  the state and (re)schedule the DO alarm at that instant. Setting a new alarm replaces any pending
   *  one, so a shot/hand-off that opens the next turn automatically cancels the old turn's deadline.
   *  Returns the ms budget to advertise to clients in `turnBegin` (0 = no limit). */
  private async armTurn(s: RoomState): Promise<number> {
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
    // In-lobby drops free the slot; in-game player drops keep it for reconnect. A SPECTATOR always
    // frees its slot on drop (it holds no turn and rarely reconnects) so ghosts can't fill the cap.
    const removeSlot = s.phase === 'lobby' || !!s.players[att.playerId]?.spectator;
    await this.dropPlayer(s, att.playerId, removeSlot);
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
        this.broadcast({t: 'turnBegin', playerIdx: Room.tankAt(s, s.turnIdx), deadline});
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
