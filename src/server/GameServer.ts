import type { WebSocket, WebSocketServer } from 'ws';
import { GAME_CONFIG } from '../shared/constants';
import { doorById, DoorField } from '../shared/doors';
import { PatrolDuty } from '../shared/duty';
import { ItemField } from '../shared/items';
import { COMPOUND, HIDDEN_PISTOL_SPOTS } from '../shared/mapData';
import {
  NET_CONFIG,
  PROTOCOL_VERSION,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '../shared/net';
import { ROLE_STATS, type Role } from '../shared/roles';
import { canCarry, WEAPONS, type WeaponId } from '../shared/weapons';
import { CombatSystem, type CombatOutcome } from './CombatSystem';
import { GuardSystem } from './GuardSystem';
import { PlayerState } from './PlayerState';
import { RoundSystem } from './RoundSystem';

/** How many of the candidate spots actually get a pistol (CLAUDE.md §23). */
const HIDDEN_PISTOL_COUNT = 3;

type Conn = {
  socket: WebSocket;
  state: PlayerState | null;
  /** Sliding one-second window used to drop a socket that floods us. */
  windowStart: number;
  windowCount: number;
};

/**
 * The authoritative session. Right now it only relays movement, but every later
 * system (combat, guards, the General, chat filtering, win conditions) hangs off
 * this class, which is why join/leave, the tick loop and message validation are
 * already separated from the transport in server.ts.
 */
export class GameServer {
  private readonly connections = new Set<Conn>();
  private readonly combat = new CombatSystem();
  private readonly guards = new GuardSystem();
  private readonly items = new ItemField();
  private readonly doors = new DoorField();
  private readonly round = new RoundSystem();
  /**
   * Patrol duties, keyed by player id — in practice one entry, the Security
   * Officer's. When the search ability lands it reads `searchEnabled` off this
   * map; until then the flag exists, is enforced by the duty, and is displayed.
   */
  private readonly duties = new Map<number, PatrolDuty>();
  private nextId = 1;
  private spawnCursor = 0;
  private readonly startedAt = Date.now();
  private lastTickMs = Date.now();
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(private readonly wss: WebSocketServer) {
    wss.on('connection', (socket) => this.onConnection(socket));
    this.seedHiddenPistols();
    this.tickTimer = setInterval(() => this.tick(), 1000 / NET_CONFIG.snapshotHz);
  }

  /** A few pistols in drawers, in random spots, so nobody can memorise the map. */
  private seedHiddenPistols(): void {
    const spots = [...HIDDEN_PISTOL_SPOTS].sort(() => Math.random() - 0.5);
    for (const spot of spots.slice(0, HIDDEN_PISTOL_COUNT)) {
      this.items.spawn('pistol', spot.x, spot.y, spot.z);
    }
  }

  /** Monotonic-ish server clock in ms; clients render remote players against it. */
  private now(): number {
    return Date.now() - this.startedAt;
  }

  close(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const conn of this.connections) conn.socket.close();
    this.wss.close();
  }

  // ---------------------------------------------------------------- lifecycle

  private onConnection(socket: WebSocket): void {
    const conn: Conn = { socket, state: null, windowStart: Date.now(), windowCount: 0 };
    this.connections.add(conn);

    socket.on('message', (data) => this.onMessage(conn, String(data)));
    socket.on('close', () => this.onClose(conn));
    socket.on('error', () => this.onClose(conn));
  }

  private onClose(conn: Conn): void {
    if (!this.connections.delete(conn)) return;
    const state = conn.state;
    if (!state) return;
    conn.state = null;
    this.broadcast({ t: 'left', id: state.id });
    // The lobby line counts heads, so it goes stale the moment one leaves.
    this.announceRound(this.livePlayers(), Date.now());
    console.log(`[-] ${state.name} (#${state.id}) left — ${this.playerCount()} online`);
  }

  private playerCount(): number {
    let n = 0;
    for (const conn of this.connections) if (conn.state) n++;
    return n;
  }

  // ----------------------------------------------------------------- messages

  private onMessage(conn: Conn, raw: string): void {
    const now = Date.now();
    if (now - conn.windowStart >= 1000) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    if (++conn.windowCount > NET_CONFIG.maxMessagesPerSecond) {
      this.reject(conn, 'message rate too high');
      return;
    }

    const msg = decode<ClientMessage>(raw);
    if (!msg) return;

    if (msg.t === 'join') {
      this.onJoin(conn, msg);
      return;
    }

    const state = conn.state;
    if (!state) return; // everything else requires a completed join

    switch (msg.t) {
      case 'state': {
        const reason = state.applyClientState(msg, now);
        if (reason) {
          state.noteCorrectionSent(now);
          this.send(conn, { t: 'correction', x: state.x, y: state.y, z: state.z, reason });
        }
        break;
      }

      case 'teleport': {
        state.teleport(msg.x, msg.y, msg.z, now);
        break;
      }

      case 'role': {
        if (!isRole(msg.role)) break;
        // Max health is per role, so switching role has to reset it or the
        // damage rules stop meaning what they say.
        state.setRole(msg.role);
        this.broadcast({ t: 'role', id: state.id, role: state.role });
        this.sendHealth(conn, state, state.id);
        // Role reissues kit, so the client's idea of what it carries is stale.
        this.send(conn, { t: 'inventory', weapons: state.inventoryList });
        break;
      }

      case 'weapon': {
        // Only what is openly held. There is no message for a concealed weapon,
        // so the server is never in a position to leak one.
        state.visibleWeapon = isWeapon(msg.weapon) ? msg.weapon : null;
        break;
      }

      case 'fire': {
        this.dispatch(
          conn,
          this.combat.fire(
            state,
            msg,
            this.livePlayers(),
            this.guards.world,
            this.doors.solids(),
            now,
          ),
        );
        break;
      }

      case 'melee': {
        this.dispatch(
          conn,
          this.combat.melee(
            state,
            msg.dx,
            msg.dz,
            this.livePlayers(),
            this.guards.world,
            this.doors.solids(),
            now,
          ),
        );
        break;
      }

      case 'pickup': {
        this.onPickup(conn, state, msg.item);
        break;
      }

      case 'door': {
        this.onDoor(state, msg.id);
        break;
      }

      case 'drop': {
        if (!isWeapon(msg.weapon) || !state.inventory.has(msg.weapon)) break;
        state.inventory.delete(msg.weapon);
        if (state.visibleWeapon === msg.weapon) state.visibleWeapon = null;
        const item = this.items.dropInFront(msg.weapon, state.x, state.y, state.z, state.yaw);
        this.broadcast({ t: 'itemAdded', item });
        this.send(conn, { t: 'inventory', weapons: state.inventoryList });
        break;
      }

      case 'respawn': {
        // A round is a round: death in it is final, and the corpse waits for the
        // result rather than getting up behind the man who shot it.
        if (!this.round.respawnAllowed) break;
        if (!this.combat.canRespawn(state, now)) break;
        const spawn = this.nextSpawn();
        state.revive(spawn.x, spawn.y, spawn.z, now);
        // Being shot settles the account: the guards who wanted this man dead
        // got him. Otherwise one offence would mark a playtester for the round.
        this.guards.world.forget(state.id);
        this.send(conn, { t: 'spawned', id: state.id, x: spawn.x, y: spawn.y, z: spawn.z });
        this.broadcast({ t: 'spawned', id: state.id, x: spawn.x, y: spawn.y, z: spawn.z }, conn);
        this.sendHealth(conn, state, state.id);
        this.send(conn, { t: 'inventory', weapons: state.inventoryList });
        break;
      }

      case 'ping': {
        if (typeof msg.id === 'number') this.send(conn, { t: 'pong', id: msg.id });
        break;
      }
    }
  }

  private onJoin(conn: Conn, msg: Extract<ClientMessage, { t: 'join' }>): void {
    if (conn.state) return; // already joined; ignore duplicates
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.reject(conn, `protocol mismatch — server speaks v${PROTOCOL_VERSION}`);
      return;
    }
    if (this.playerCount() >= NET_CONFIG.maxPlayers) {
      this.reject(conn, 'server full');
      return;
    }

    const role: Role = isRole(msg.role) ? msg.role : 'doctor';
    const name = cleanName(msg.name, this.nextId);
    const spawn = this.nextSpawn();

    const state = new PlayerState(
      this.nextId++,
      name,
      role,
      spawn.x,
      spawn.y,
      spawn.z,
      Date.now(),
    );
    conn.state = state;

    const others: PlayerState[] = [];
    for (const other of this.connections) {
      if (other !== conn && other.state) others.push(other.state);
    }

    this.send(conn, {
      t: 'welcome',
      id: state.id,
      you: state.info,
      spawn: { x: state.x, y: state.y, z: state.z },
      players: others.map((p) => p.info),
      snapshotHz: NET_CONFIG.snapshotHz,
      health: state.health,
      maxHealth: state.maxHealth,
      items: this.items.list(),
      inventory: state.inventoryList,
      doors: this.doors.openIds(),
    });
    this.broadcast({ t: 'joined', player: state.info }, conn);
    // Where the session is. A player who joins mid-round is a bystander until
    // the next one: no allegiance is dealt to them, so `you` is absent and the
    // HUD shows the clock without a faction line.
    this.announceRound(this.livePlayers(), Date.now());

    console.log(
      `[+] ${name} (#${state.id}, ${ROLE_STATS[role].name}) joined — ${this.playerCount()} online`,
    );
  }

  // --------------------------------------------------------------------- items

  /**
   * The server decides who actually gets it. Two players diving for the same
   * pistol both send `pickup`; only the first one to arrive here is holding
   * anything afterwards.
   */
  private onPickup(conn: Conn, state: PlayerState, id: unknown): void {
    if (typeof id !== 'number' || !state.alive) return;
    const item = this.items.get(id);
    if (!item) return;
    if (Math.hypot(item.x - state.x, item.z - state.z) > GAME_CONFIG.items.reach) return;
    // One of each in the prototype; there is no ammo pooling to make two useful.
    if (state.inventory.has(item.weapon)) return;
    // A rifle is a metre of wood and steel: only the Security Officer has any
    // business picking one up, so a dead guard's rifle is useless to a clerk.
    if (!canCarry(state.role, item.weapon)) return;

    this.items.remove(id);
    state.inventory.add(item.weapon);
    this.broadcast({ t: 'itemRemoved', id });
    this.send(conn, { t: 'inventory', weapons: state.inventoryList });
  }

  /**
   * Doors are the one piece of world state a player can change directly, so the
   * check is the same one pickup makes: you must be alive, and you must be close
   * enough to have touched it. Nothing else is trusted — not that the door
   * exists, not which way it was already facing.
   */
  private onDoor(state: PlayerState, id: unknown): void {
    if (typeof id !== 'number' || !state.alive) return;
    const def = doorById(id);
    if (!def) return;
    if (Math.hypot(def.x - state.x, def.z - state.z) > GAME_CONFIG.world.doorReach) return;
    this.doors.toggle(id);
    this.broadcast({ t: 'doors', open: this.doors.openIds() });
  }

  private applyDrops(drops: CombatOutcome['drops']): void {
    for (const drop of drops) {
      for (const item of this.items.spill(drop.weapons, drop.x, drop.y, drop.z)) {
        this.broadcast({ t: 'itemAdded', item });
      }
    }
  }

  // -------------------------------------------------------------------- combat

  private livePlayers(): PlayerState[] {
    const players: PlayerState[] = [];
    for (const conn of this.connections) if (conn.state) players.push(conn.state);
    return players;
  }

  private connFor(playerId: number): Conn | null {
    for (const conn of this.connections) if (conn.state?.id === playerId) return conn;
    return null;
  }

  private nextSpawn(): { x: number; y: number; z: number } {
    const spawn = COMPOUND.spawnPoints[this.spawnCursor % COMPOUND.spawnPoints.length];
    this.spawnCursor++;
    return { x: spawn.x, y: spawn.y, z: spawn.z };
  }

  /** Health goes ONLY to its owner — nobody may read another player's HP. */
  private sendHealth(conn: Conn, state: PlayerState, byId: number): void {
    this.send(conn, { t: 'health', health: state.health, maxHealth: state.maxHealth, byId });
  }

  /** `attacker` is null when the attack came from a guard, who has no socket. */
  private dispatch(attacker: Conn | null, outcome: CombatOutcome): void {
    for (const msg of outcome.toAll) this.broadcast(msg);
    if (attacker) for (const msg of outcome.toAttacker) this.send(attacker, msg);
    for (const update of outcome.healthUpdates) {
      const victimConn = this.connFor(update.player.id);
      if (victimConn) this.sendHealth(victimConn, update.player, update.byId);
    }
    // Whoever died, their kit is on the floor now and everyone can see it.
    this.applyDrops(outcome.drops);
    for (const update of outcome.healthUpdates) {
      if (update.player.alive) continue;
      const victimConn = this.connFor(update.player.id);
      if (victimConn) this.send(victimConn, { t: 'inventory', weapons: update.player.inventoryList });
    }
  }

  private reject(conn: Conn, reason: string): void {
    this.send(conn, { t: 'reject', reason });
    conn.socket.close();
    this.onClose(conn);
  }

  // ------------------------------------------------------------------- ticking

  private tick(): void {
    const nowWall = Date.now();
    // Clamped: a stalled event loop must not hand the guards a huge step and
    // teleport them through a wall.
    const dt = Math.min(0.25, (nowWall - this.lastTickMs) / 1000);
    this.lastTickMs = nowWall;

    const players = this.livePlayers();
    if (players.length > 0) {
      const before = this.doors.openIds().length;
      this.dispatch(null, this.guards.tick(dt, nowWall, players, this.doors));
      // Guards push doors open as they walk into them; everyone has to be told.
      if (this.doors.openIds().length !== before) {
        this.broadcast({ t: 'doors', open: this.doors.openIds() });
      }
    }

    this.tickRound(players, nowWall);
    this.tickDuties(players, dt * 1000, nowWall);
    this.broadcastSnapshot();
  }

  // --------------------------------------------------------------------- round

  /**
   * The round drives itself: it starts when enough people are here and ends
   * when one of the three win checks fires or the clock runs out. Nobody has to
   * call for a match, which matters at a playtest where the host is also playing.
   */
  private tickRound(players: readonly PlayerState[], now: number): void {
    const phaseWas = this.round.phase;

    if (this.round.phase === 'lobby' && players.length >= GAME_CONFIG.round.minPlayers) {
      this.startRound(players, now);
    }

    const result = this.round.tick(players, this.guards.world.generalAlive, now);
    if (result) {
      // Sent to everyone, and only now: this is the one message in the protocol
      // that carries other people's allegiances, and the round is already over.
      this.broadcast(this.round.reveal(players));
      console.log(`[round] ${result.winner}s win — ${result.reason}`);
    }

    if (this.round.phase !== phaseWas || result) this.announceRound(players, now);
  }

  private startRound(players: readonly PlayerState[], now: number): void {
    this.round.start(players, now);

    // Everything that was true of the last round stops being true: the guards go
    // back on post, the General gets up, the floor is swept and the drawers are
    // restocked somewhere else.
    this.guards.world.reset();
    this.items.clear();
    this.seedHiddenPistols();
    this.doors.setAll([]);
    this.broadcast({ t: 'doors', open: [] });
    this.broadcast({ t: 'itemsReset', items: this.items.list() });

    for (const player of players) {
      const spawn = this.nextSpawn();
      player.revive(spawn.x, spawn.y, spawn.z, now);
      this.guards.world.forget(player.id);
      const conn = this.connFor(player.id);
      if (!conn) continue;
      this.broadcast({ t: 'role', id: player.id, role: player.role });
      this.send(conn, { t: 'spawned', id: player.id, x: spawn.x, y: spawn.y, z: spawn.z });
      this.broadcast({ t: 'spawned', id: player.id, x: spawn.x, y: spawn.y, z: spawn.z }, conn);
      this.sendHealth(conn, player, player.id);
      this.send(conn, { t: 'inventory', weapons: player.inventoryList });
    }

    console.log(`[round] started with ${players.length} players`);
  }

  // --------------------------------------------------------------------- duty

  /**
   * The officer's patrol, checked against where he is actually standing
   * (CLAUDE.md §15). Messages go out only when something he can see changes —
   * he counts the clock down himself, the same way he does the round timer.
   */
  private tickDuties(players: readonly PlayerState[], dtMs: number, now: number): void {
    for (const player of players) {
      this.syncDuty(player, now);
      const duty = this.duties.get(player.id);
      // A dead officer is not neglecting his patrol; he is dead. The deadline
      // still runs, which is correct — the compound does not wait for him.
      if (!duty || !player.alive) continue;
      if (duty.tick(player.x, player.z, now, dtMs)) this.sendDuty(player, duty, now);
    }

    if (this.duties.size <= players.length) return;
    const live = new Set(players.map((p) => p.id));
    for (const id of [...this.duties.keys()]) if (!live.has(id)) this.duties.delete(id);
  }

  /** A patrol exists for exactly as long as he is the officer and a round is on. */
  private syncDuty(player: PlayerState, now: number): void {
    const wants = this.round.running && player.role === 'security';
    const has = this.duties.get(player.id);
    if (wants === Boolean(has)) return;

    if (wants) {
      const duty = new PatrolDuty();
      duty.start(now);
      this.duties.set(player.id, duty);
      this.sendDuty(player, duty, now);
    } else {
      this.duties.delete(player.id);
      this.sendDuty(player, null, now);
    }
  }

  private sendDuty(player: PlayerState, duty: PatrolDuty | null, now: number): void {
    const conn = this.connFor(player.id);
    if (conn) this.send(conn, { t: 'duty', duty: duty ? duty.status(now) : null });
  }

  /**
   * One message per player, never a broadcast. `RoundSystem.announce` fills in
   * `you.faction` for that recipient alone, and this is the only caller.
   */
  private announceRound(players: readonly PlayerState[], now: number): void {
    for (const player of players) {
      const conn = this.connFor(player.id);
      if (conn) this.send(conn, this.round.announce(player.id, players.length, now));
    }
  }

  /**
   * Each client is told about everyone EXCEPT itself. Echoing a player's own
   * position back would only give the client something to fight with.
   */
  private broadcastSnapshot(): void {
    const time = this.now();
    const live: PlayerState[] = [];
    for (const conn of this.connections) if (conn.state) live.push(conn.state);
    // One player alone still needs snapshots: the guards are in them.
    if (live.length === 0) return;

    const npcs = this.guards.world.snapshots();
    for (const conn of this.connections) {
      const self = conn.state;
      if (!self) continue;
      const players = live.filter((p) => p.id !== self.id).map((p) => p.snapshot);
      this.send(conn, { t: 'snapshot', time, players, npcs });
    }
  }

  // -------------------------------------------------------------------- output

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.socket.readyState !== 1 /* OPEN */) return;
    conn.socket.send(encode(msg));
  }

  private broadcast(msg: ServerMessage, except?: Conn): void {
    for (const conn of this.connections) {
      if (conn === except || !conn.state) continue;
      this.send(conn, msg);
    }
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_STATS, value);
}

function isWeapon(value: unknown): value is WeaponId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, value);
}

function cleanName(raw: unknown, fallbackId: number): string {
  if (typeof raw !== 'string') return `player ${fallbackId}`;
  // Strip control characters so a name cannot mangle another player's UI.
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed) return `player ${fallbackId}`;
  return trimmed.slice(0, NET_CONFIG.maxNameLength);
}
