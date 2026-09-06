import type { WebSocket, WebSocketServer } from 'ws';
import { GAME_CONFIG } from '../shared/constants';
import { doorById, doorPermits, DoorField } from '../shared/doors';
import { DeliveryDuty, PatrolDuty, medicalStatus, type DutyStatus } from '../shared/duty';
import { ITEMS, isWeaponItem } from '../shared/inventory';
import { ItemField } from '../shared/items';
import { ContainerField } from '../shared/containers';
import { PatientSystem } from '../shared/medical';
import { TelegramSystem } from '../shared/telegrams';
import {
  COMPOUND,
  CONTAINERS,
  GUARD_SPAWNS,
  HIDDEN_PISTOL_SPOTS,
  ROLE_SPAWNS,
} from '../shared/mapData';
import {
  NET_CONFIG,
  PROTOCOL_VERSION,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '../shared/net';
import { ROLE_STATS, type Role } from '../shared/roles';
import { canCarry, canConceal, WEAPONS, type WeaponId } from '../shared/weapons';
import { CombatSystem, type CombatOutcome } from './CombatSystem';
import { GuardSystem } from './GuardSystem';
import { PlayerState } from './PlayerState';
import { RoundSystem } from './RoundSystem';
import { SEARCH_REFUSAL_TEXT, SearchSystem, type ActiveSearch } from './SearchSystem';

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
   * Officer's. `SearchSystem` reads `searchEnabled` off this map, which is the
   * whole reason the patrol exists: it is the only thing that can take the
   * search away, and walking a checkpoint gives it straight back (CLAUDE.md §15).
   */
  private readonly duties = new Map<number, PatrolDuty>();
  /** Dispatch runs, keyed by player id — the Secretary's (CLAUDE.md §32). */
  private readonly deliveries = new Map<number, DeliveryDuty>();
  private readonly search = new SearchSystem();
  private readonly containers = new ContainerField();
  private readonly patients = new PatientSystem();
  private readonly telegrams = new TelegramSystem();
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
    // A hold cannot survive one of its two parties walking out of the building.
    const dropped = this.search.abort(state.id, this.livePlayers(), Date.now());
    if (dropped) this.sendSearch(dropped, 'end');
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
        // Re-apply the rifle-visibility rule after a role change.
        if (state.inventory.has('rifle') && !canConceal(state.role, 'rifle')) {
          state.visibleWeapon = 'rifle';
        }
        this.broadcast({ t: 'role', id: state.id, role: state.role });
        this.sendHealth(conn, state, state.id);
        // Role reissues kit, so the client's idea of what it carries is stale.
        this.send(conn, { t: 'inventory', items: state.inventoryList });
        break;
      }

      case 'weapon': {
        // Only what is openly held. There is no message for a concealed weapon,
        // so the server is never in a position to leak one.
        state.visibleWeapon = isWeapon(msg.weapon) ? msg.weapon : null;
        // A non-Security role cannot conceal a rifle: force it into view.
        if (state.inventory.has('rifle') && !canConceal(state.role, 'rifle')) {
          state.visibleWeapon = 'rifle';
        }
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
        this.broadcastNoise(state.x, state.z, 'gunshot');
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
        this.broadcastNoise(state.x, state.z, 'melee');
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
        if (!isItem(msg.item) || !state.inventory.has(msg.item)) break;
        state.inventory.delete(msg.item);
        if (isWeaponItem(msg.item) && state.visibleWeapon === msg.item) state.visibleWeapon = null;
        const item = this.items.dropInFront(msg.item, state.x, state.y, state.z, state.yaw);
        this.broadcast({ t: 'itemAdded', item });
        this.send(conn, { t: 'inventory', items: state.inventoryList });
        break;
      }

      case 'openContainer': {
        if (!state.alive || typeof msg.id !== 'number') break;
        const cdef = CONTAINERS.find((c) => c.id === msg.id);
        if (!cdef) break;
        const dx = state.x - cdef.x;
        const dz = state.z - cdef.z;
        if (Math.sqrt(dx * dx + dz * dz) > GAME_CONFIG.world.containerReach) break;
        const found = this.containers.open(msg.id);
        if (found === null) {
          this.send(conn, { t: 'alert', text: 'Container already searched.' });
          break;
        }
        // Spill items on the floor near the container.
        if (found.length > 0) {
          this.items.spill(found, cdef.x, 0, cdef.z);
          this.broadcast({ t: 'itemsReset', items: this.items.list() });
    this.broadcast({ t: 'patients', patients: this.patients.publicUpdates() });
        }
        this.send(conn, { t: 'container', id: msg.id, items: found });
        break;
      }

      case 'use': {
        if (!isItem(msg.item) || !state.inventory.has(msg.item) || isWeaponItem(msg.item)) break;
        if (msg.item === 'medkit') {
          state.inventory.delete('medkit');
          state.health = state.maxHealth;
          this.sendHealth(conn, state, state.id);
          this.send(conn, { t: 'inventory', items: state.inventoryList });
        } else if (msg.item === 'report') {
          // Read privately. The item is NOT consumed — only broadcasting spends
          // it, so an operator may sit on what he knows for as long as he likes.
          const report = this.buildReport(state);
          this.send(conn, report ?? { t: 'alert', text: 'THE REPORT NAMES NOBODY' });
        } else if (msg.item === 'gauze' || msg.item === 'morphine') {
          this.send(conn, { t: 'alert', text: 'Use that on a patient in the medical ward — hold [E] near a bed.' });
        }
        break;
      }

      case 'examine': {
        if (!state.alive || typeof msg.patientId !== 'number') break;
        const need = this.patients.examine(msg.patientId, state.id);
        if (need !== null) {
          this.send(conn, { t: 'examine', patientId: msg.patientId, need });
        }
        break;
      }

      case 'treat': {
        if (!state.alive || typeof msg.patientId !== 'number') break;
        if (!isItem(msg.item) || !state.inventory.has(msg.item)) break;
        if (this.patients.treat(msg.patientId, msg.item)) {
          state.inventory.delete(msg.item);
          this.send(conn, { t: 'inventory', items: state.inventoryList });
          this.broadcast({ t: 'patients', patients: this.patients.publicUpdates() });
          this.send(conn, { t: 'alert', text: 'Patient stabilised.' });
        } else {
          this.send(conn, { t: 'alert', text: 'That is not what this patient needs.' });
        }
        break;
      }

      case 'startPuzzle': {
        if (!state.alive) break;
        const puzzle = this.telegrams.startPuzzle(state.id);
        this.send(conn, { t: 'puzzle', id: puzzle.id, scrambled: puzzle.scrambled });
        break;
      }

      case 'puzzleAnswer': {
        if (!state.alive || typeof msg.word !== 'string') break;
        const result = this.telegrams.answer(state.id, msg.word);
        if (!result.correct) {
          this.send(conn, { t: 'alert', text: `Incorrect — try again.` });
          break;
        }
        this.send(conn, { t: 'alert', text: `Correct! (${result.totalDeciphers} deciphered)` });
        // The intelligence arrives as a THING, not as a private message. Making
        // it an item means it can be dropped, looted off a corpse, or taken in a
        // search — the most valuable information in the round is physical.
        if (result.earnedReport && !state.inventory.has('report')) {
          state.inventory.add('report');
          this.send(conn, { t: 'inventory', items: state.inventoryList });
          this.send(conn, { t: 'alert', text: 'SIGNALS REPORT RECEIVED — [U] TO READ' });
        }
        this.sendDuty(state, null, now);
        break;
      }

      case 'chat': {
        if (!state.alive || typeof msg.text !== 'string') break;
        const text = msg.text.trim().slice(0, 200);
        if (!text) break;
        const isBroadcast = msg.broadcast === true && state.role === 'telegram'
          && this.telegrams.canBroadcast(state.id, now);
        if (isBroadcast) {
          this.telegrams.setBroadcastUsed(state.id, now);
          this.broadcast({ t: 'chatMsg', from: state.id, name: state.name, text, channel: 'broadcast' });
        } else {
          const chatRadius = GAME_CONFIG.chat.proximityRadius;
          for (const c of this.connections) {
            if (!c.state?.alive) continue;
            const dx = c.state.x - state.x;
            const dz = c.state.z - state.z;
            if (Math.sqrt(dx * dx + dz * dz) <= chatRadius) {
              this.send(c, { t: 'chatMsg', from: state.id, name: state.name, text, channel: 'local' });
            }
          }
        }
        break;
      }

      case 'searchStart': {
        if (typeof msg.target !== 'number') break;
        const patrol = this.duties.get(state.id);
        const begun = this.search.begin(
          state,
          msg.target,
          patrol?.searchEnabled ?? false,
          this.livePlayers(),
          this.guards.world,
          now,
        );
        if (typeof begun === 'string') {
          this.send(conn, { t: 'alert', text: SEARCH_REFUSAL_TEXT[begun] });
          break;
        }
        this.sendSearch(begun, 'begin');
        break;
      }

      case 'searchRelease': {
        const held = this.search.current;
        if (!held || held.officer !== state.id) break;
        const ended = this.search.end(this.livePlayers(), now);
        if (ended) this.sendSearch(ended, 'end');
        break;
      }

      case 'confiscate': {
        if (!isItem(msg.item)) break;
        const held = this.search.current;
        if (!held || held.officer !== state.id) break;
        const outcome = this.search.confiscate(msg.item, this.livePlayers(), this.guards.world);
        if (!outcome) break;
        if (outcome === 'dropped') {
          // He already had one. It lands at his feet, where anybody can take it.
          const dropped = this.items.dropInFront(msg.item, state.x, state.y, state.z, state.yaw);
          this.broadcast({ t: 'itemAdded', item: dropped });
          this.send(conn, { t: 'alert', text: `${ITEMS[msg.item].name} — DROPPED AT YOUR FEET` });
        } else {
          this.send(conn, { t: 'inventory', items: state.inventoryList });
        }
        // Refresh the officer's list. The target is told his pockets changed but
        // never that anyone else was told anything.
        this.sendSearch(held, 'begin');
        if (!held.targetIsNpc) {
          const targetConn = this.connFor(held.target);
          if (targetConn?.state) {
            this.send(targetConn, { t: 'inventory', items: targetConn.state.inventoryList });
          }
        }
        break;
      }

      case 'broadcastReport': {
        if (!state.alive || typeof msg.target !== 'number') break;
        if (!state.inventory.has('report')) break;
        const report = this.buildReport(state);
        const candidate = report?.candidates.find((c) => c.id === msg.target);
        if (!candidate) break;

        // Spent. There is exactly one operator, so the accusation is inherently
        // attributed — which is what makes lying with it expensive.
        state.inventory.delete('report');
        this.send(conn, { t: 'inventory', items: state.inventoryList });

        const targetPlayer = this.livePlayers().find((p) => p.id === msg.target);
        if (targetPlayer) {
          targetPlayer.flagged = true;
          // A permanent, compound-wide grudge: every guard shoots on sight. The
          // flagged character IS the threat here, so the grudge point and the
          // last-known point are both his own position, and the guards face the
          // right way instead of crowding somewhere he has already left.
          const at = { x: targetPlayer.x, z: targetPlayer.z };
          this.guards.world.provoke(targetPlayer.id, at, 200, at);
        } else {
          // Guard grudges are keyed to player ids, so flagging an NPC is a label
          // and an announcement — the humans who believe it do the rest.
          this.guards.world.setFlagged(msg.target);
        }
        this.broadcast({ t: 'flagged', id: msg.target, label: candidate.label });
        this.broadcast({ t: 'announce', text: `TELEGRAPH: ${candidate.label} IS AN INFILTRATOR` });
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
        this.send(conn, { t: 'inventory', items: state.inventoryList });
        break;
      }

      case 'ping': {
        if (typeof msg.id === 'number') this.send(conn, { t: 'pong', id: msg.id });
        break;
      }

      case 'reset': {
        const players = this.livePlayers();
        if (players.length > 0) this.startRound(players, Date.now());
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
    // One of each in the prototype; there is no pooling to make two useful.
    if (state.inventory.has(item.item)) return;
    // A rifle is a metre of wood and steel: only the Security Officer has any
    // business picking one up, so a dead guard's rifle is useless to a clerk.
    if (isWeaponItem(item.item) && !canCarry(state.role, item.item)) return;

    this.items.remove(id);
    state.inventory.add(item.item);
    // A non-Security role picking up a rifle cannot conceal it.
    if (item.item === 'rifle' && !canConceal(state.role, 'rifle')) {
      state.visibleWeapon = 'rifle';
    }
    this.broadcast({ t: 'itemRemoved', id });
    this.send(conn, { t: 'inventory', items: state.inventoryList });
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
    // Check access after toggling so the door physically opens (the surprise is
    // the guards reacting, not a door that refuses to move).
    if (!doorPermits(def, state.role, state.visibleWeapon, state.hqAccess)) {
      this.guards.world.reportViolation(state.id, { x: def.x, z: def.z });
    }
    this.broadcastNoise(def.x, def.z, 'door');
  }

  /** Send a noise marker to every player within the weapon's hear radius. */
  private broadcastNoise(x: number, z: number, kind: 'gunshot' | 'melee' | 'door'): void {
    const radius = kind === 'gunshot' ? GAME_CONFIG.guards.gunshotHearRadius
      : kind === 'melee' ? 8
      : GAME_CONFIG.chat.proximityRadius;
    for (const c of this.connections) {
      if (!c.state) continue;
      const dx = c.state.x - x;
      const dz = c.state.z - z;
      if (Math.sqrt(dx * dx + dz * dz) <= radius) {
        this.send(c, { t: 'noise', x, z, kind });
      }
    }
  }

  private applyDrops(drops: CombatOutcome['drops']): void {
    for (const drop of drops) {
      for (const item of this.items.spill(drop.items, drop.x, drop.y, drop.z)) {
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
      if (victimConn) this.send(victimConn, { t: 'inventory', items: update.player.inventoryList });
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
      this.dispatch(null, this.guards.tick(dt, nowWall, players, this.doors, this.items));
      // Guards push doors open as they walk into them; everyone has to be told.
      if (this.doors.openIds().length !== before) {
        this.broadcast({ t: 'doors', open: this.doors.openIds() });
      }
    }

    this.tickRound(players, nowWall);
    this.tickDuties(players, dt * 1000, nowWall);
    this.tickSearch(players, nowWall);
    this.tickPatients(dt, nowWall);
    this.broadcastSnapshot();
  }

  /**
   * The ward, and the bridge between its two halves.
   *
   * A patient is one character in two systems: an `Npc` body that can be shot
   * and a `PatientState` that can deteriorate. They share an id (see
   * `NpcWorld.patientIds`) and this is where they are reconciled, so a patient
   * can never be dead in one and alive in the other. The two causes of death
   * announce differently on purpose: neglect points at the Doctor, gunfire
   * points at whoever was in the ward with a weapon.
   */
  private tickPatients(dt: number, now: number): void {
    let changed = false;

    for (const patient of this.patients.all) {
      if (patient.status === 'dead') continue;
      if (this.guards.world.info(patient.id)?.alive !== false) continue;
      if (this.patients.kill(patient.id, 'gunfire')) {
        changed = true;
        this.broadcast({ t: 'announce', text: 'A PATIENT HAS BEEN SHOT IN THE MEDICAL WARD' });
      }
    }

    const { updates, deaths } = this.patients.tick(dt);
    for (const id of deaths) {
      // Nobody attacked him, so nothing here may make a guard hostile — but the
      // body still has to lie down.
      this.guards.world.expire(id);
      this.broadcast({ t: 'announce', text: 'A PATIENT HAS DIED IN THE MEDICAL WARD' });
    }

    if (!changed && updates.length === 0) return;
    this.broadcast({ t: 'patients', patients: this.patients.publicUpdates() });
    // The Doctor's duty line is a live read of the ward rather than state of its
    // own, so it has to be repushed whenever the ward moves.
    if (!this.round.running) return;
    for (const conn of this.connections) {
      const who = conn.state;
      if (who?.role === 'doctor') this.send(conn, { t: 'duty', duty: this.roleDutyStatus(who, now) });
    }
  }

  // -------------------------------------------------------------------- search

  /**
   * Auto-release, and the two ways a hold can be cut short: either party dying,
   * or the officer leaving. The decision window is generous precisely so that
   * standing still together is a long, public, interruptible event.
   */
  private tickSearch(players: readonly PlayerState[], now: number): void {
    const held = this.search.current;
    if (held) {
      const officer = players.find((p) => p.id === held.officer);
      const targetGone = held.targetIsNpc
        ? this.guards.world.info(held.target)?.alive !== true
        : players.find((p) => p.id === held.target)?.alive !== true;
      if (!officer?.alive || targetGone) {
        const cut = this.search.end(players, now);
        if (cut) this.sendSearch(cut, 'end');
        return;
      }
    }
    const released = this.search.tick(players, now);
    if (released) this.sendSearch(released, 'end');
  }

  /**
   * The asymmetry, in one function (CLAUDE.md §16).
   *
   * Everyone nearby is told THAT a search is happening, because two people
   * standing perfectly still together is a public event and half the value of
   * the mechanic is bystanders watching it. `items` rides on the officer's copy
   * and no other — not even the copy addressed to the person being searched.
   * That is what lets an officer find a pistol and say he found nothing.
   */
  private sendSearch(search: ActiveSearch, phase: 'begin' | 'end'): void {
    const players = this.livePlayers();
    const officer = players.find((p) => p.id === search.officer);
    const radius = GAME_CONFIG.chat.proximityRadius;
    const items = phase === 'begin'
      ? this.search.itemsOf(search, players, this.guards.world)
      : [];

    for (const conn of this.connections) {
      const who = conn.state;
      if (!who) continue;
      const involved = who.id === search.officer || who.id === search.target;
      // An officer who has disconnected has no position to measure from; the
      // release still has to reach the target, so it goes to everyone.
      const near = !officer || Math.hypot(who.x - officer.x, who.z - officer.z) <= radius;
      if (!involved && !near) continue;
      if (who.id === search.officer && phase === 'begin') {
        this.send(conn, { t: 'search', phase, officer: search.officer, target: search.target, items });
      } else {
        this.send(conn, { t: 'search', phase, officer: search.officer, target: search.target });
      }
    }
  }

  // -------------------------------------------------------------------- report

  /**
   * What the signals report says. Built fresh on every read so it survives a
   * disconnect, and never cached, because the candidate list is the roster and
   * the roster can lose people.
   *
   * The Security Officer is absent from the candidates: he is always a Loyalist,
   * so accusing him could only ever be noise. Players and NPCs are mixed into
   * one undifferentiated list — an operator who could tell which candidates were
   * human would have broken the disguise the whole roster exists to maintain.
   */
  private buildReport(operator: PlayerState): Extract<ServerMessage, { t: 'report' }> | null {
    const candidates: { id: number; label: string }[] = [];
    for (const player of this.livePlayers()) {
      if (player.id === operator.id || player.role === 'security') continue;
      candidates.push({ id: player.id, label: player.label || player.name });
    }
    for (const npc of this.guards.world.rosterEntries) {
      candidates.push({ id: npc.id, label: npc.label });
    }
    candidates.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

    const ids = new Set(candidates.map((c) => c.id));
    const pool = this.round.infiltratorIds.filter((id) => id !== operator.id && ids.has(id));
    if (pool.length === 0) return null;
    // The intelligence never lies. Only the operator's broadcast can.
    const truth = pool[Math.floor(Math.random() * pool.length)]!;
    return { t: 'report', truth, candidates };
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

    const result = this.round.tick(
      players,
      {
        generalAlive: this.guards.world.generalAlive,
        patientsDead: this.patients.deadCount,
        patientCauses: this.patients.deathCauses,
      },
      now,
    );
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
    // The roster decides who the NPCs are, so the guards cannot be rebuilt until
    // the round has dealt it (`round.start` above).
    this.guards.world.reset(this.round.npcSeats);
    this.search.reset();
    this.duties.clear();
    this.deliveries.clear();
    this.items.clear();
    this.seedHiddenPistols();
    this.containers.reset();
    this.containers.seed(['medkit', 'gauze', 'morphine', 'medkit', 'gauze', 'morphine', 'medkit', 'gauze']);
    // One id space: the ward's patients ARE the bodies lying in it.
    this.patients.reset(this.guards.world.patientIds);
    this.telegrams.reset();
    this.doors.setAll([]);
    this.broadcast({ t: 'doors', open: [] });
    this.broadcast({ t: 'itemsReset', items: this.items.list() });

    // Human Guards fan out one per field post; everyone else has a fixed one.
    let guardSpawn = 0;
    for (const player of players) {
      const roleSpawn = player.role === 'guard'
        ? GUARD_SPAWNS[guardSpawn++] ?? ROLE_SPAWNS.guard
        : ROLE_SPAWNS[player.role];
      const spawn = roleSpawn ?? this.nextSpawn();
      player.flagged = false;
      player.revive(spawn.x, spawn.y, spawn.z, now);
      this.guards.world.forget(player.id);
      const conn = this.connFor(player.id);
      if (!conn) continue;
      this.broadcast({ t: 'role', id: player.id, role: player.role });
      this.send(conn, { t: 'spawned', id: player.id, x: spawn.x, y: spawn.y, z: spawn.z });
      this.broadcast({ t: 'spawned', id: player.id, x: spawn.x, y: spawn.y, z: spawn.z }, conn);
      this.sendHealth(conn, player, player.id);
      this.send(conn, { t: 'inventory', items: player.inventoryList });
      // Send role-specific duty for non-security roles. The Secretary's real
      // line arrives a tick later, when `syncDuty` issues her the dispatch run.
      if (player.role !== 'security') {
        this.send(conn, { t: 'duty', duty: this.roleDutyStatus(player, now) });
      }
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
      // A dead officer is not neglecting his patrol; he is dead. The deadline
      // still runs, which is correct — the compound does not wait for him.
      if (!player.alive) continue;

      const patrol = this.duties.get(player.id);
      if (patrol) {
        if (patrol.tick(player.x, player.z, now, dtMs)) this.sendDuty(player, patrol, now);
        continue;
      }

      const delivery = this.deliveries.get(player.id);
      if (!delivery) continue;
      const changed = delivery.tick(
        player.x,
        player.z,
        player.inventory.has('telegram'),
        now,
        dtMs,
      );
      // The ONLY punishment for missing deliveries, and it is not a score: from
      // here the HQ door and the guards treat her exactly as they treat a
      // doctor, and everyone can watch it happen (CLAUDE.md §32).
      player.hqAccess = !delivery.banned;
      if (delivery.holdComplete) {
        this.completeDelivery(player, delivery, now);
      } else if (changed) {
        this.sendDuty(player, null, now);
      }
    }

    const live = new Set(players.map((p) => p.id));
    for (const id of [...this.duties.keys()]) if (!live.has(id)) this.duties.delete(id);
    for (const id of [...this.deliveries.keys()]) if (!live.has(id)) this.deliveries.delete(id);
  }

  /** One leg of the dispatch run finished: hand over or take the dispatch. */
  private completeDelivery(player: PlayerState, duty: DeliveryDuty, now: number): void {
    const conn = this.connFor(player.id);
    if (duty.phase === 'collect') {
      player.inventory.add('telegram');
      if (conn) {
        this.send(conn, { t: 'inventory', items: player.inventoryList });
        this.send(conn, { t: 'alert', text: 'DISPATCH COLLECTED — TAKE IT TO THE GENERAL' });
      }
    } else {
      player.inventory.delete('telegram');
      if (conn) {
        this.send(conn, { t: 'inventory', items: player.inventoryList });
        this.send(conn, { t: 'alert', text: 'DISPATCH DELIVERED' });
      }
    }
    duty.advance(now);
    this.sendDuty(player, null, now);
  }

  /**
   * A duty exists for exactly as long as the player holds the role and a round
   * is on. Two roles carry state (the officer's patrol, the secretary's dispatch
   * run); the doctor's and the operator's lines are pure reads, so they need no
   * bookkeeping here.
   */
  private syncDuty(player: PlayerState, now: number): void {
    const running = this.round.running;
    const wantsPatrol = running && player.role === 'security';
    const wantsDelivery = running && player.role === 'secretary';
    const hasPatrol = this.duties.has(player.id);
    const hasDelivery = this.deliveries.has(player.id);
    if (wantsPatrol === hasPatrol && wantsDelivery === hasDelivery) return;

    if (!wantsPatrol && hasPatrol) this.duties.delete(player.id);
    if (!wantsDelivery && hasDelivery) {
      this.deliveries.delete(player.id);
      // Losing the duty restores the pass; only an active, missed run revokes it.
      player.hqAccess = true;
    }

    if (wantsPatrol && !hasPatrol) {
      const duty = new PatrolDuty();
      duty.start(now);
      this.duties.set(player.id, duty);
      this.sendDuty(player, duty, now);
      return;
    }
    if (wantsDelivery && !hasDelivery) {
      const duty = new DeliveryDuty();
      duty.start(now);
      this.deliveries.set(player.id, duty);
    }
    this.sendDuty(player, null, now);
  }

  private sendDuty(player: PlayerState, duty: PatrolDuty | null, now: number): void {
    const conn = this.connFor(player.id);
    if (!conn) return;
    if (duty) {
      this.send(conn, { t: 'duty', duty: duty.status(now) });
      return;
    }
    // Non-security roles get a simple static duty line.
    if (!this.round.running) {
      this.send(conn, { t: 'duty', duty: null });
      return;
    }
    this.send(conn, { t: 'duty', duty: this.roleDutyStatus(player, now) });
  }

  /**
   * The duty line for a role that is not the officer's patrol. The doctor's and
   * the operator's are live reads of the ward and the puzzle count rather than
   * stored progress, so neither can be "completed" and then abandoned.
   */
  private roleDutyStatus(player: PlayerState, now: number): DutyStatus | null {
    switch (player.role) {
      case 'doctor':
        return medicalStatus(this.patients.worst);
      case 'secretary':
        return this.deliveries.get(player.id)?.status(now) ?? null;
      case 'telegram':
        return {
          label: 'SIGNALS DUTY',
          detail: `DECIPHER TELEGRAMS — ${this.telegrams.deciphers(player.id)} / ${GAME_CONFIG.telegram.deciphersForIntel}`,
          secondsLeft: 0,
          ok: true,
          dwell: 0,
        };
      case 'guard':
        return { label: 'GUARD DUTY', detail: 'HOLD YOUR POST', secondsLeft: 0, ok: true, dwell: 0 };
      default:
        return null;
    }
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

function isItem(value: unknown): value is import('../shared/inventory').ItemId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, value);
}

function cleanName(raw: unknown, fallbackId: number): string {
  if (typeof raw !== 'string') return `player ${fallbackId}`;
  // Strip control characters so a name cannot mangle another player's UI.
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed) return `player ${fallbackId}`;
  return trimmed.slice(0, NET_CONFIG.maxNameLength);
}
