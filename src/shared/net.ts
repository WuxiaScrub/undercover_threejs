/**
 * The wire protocol (milestone 2). Plain JSON — at six players and 20 Hz the
 * whole thing is a few KB/s, and being able to read the frames in devtools is
 * worth far more than the bytes a binary format would save.
 *
 * Authority model (see the plan): the client owns its OWN movement and the
 * server only refuses moves that are physically impossible. Everything that a
 * client must not be trusted with — health, hit detection, roles, factions,
 * guards, chat filtering — moves here from milestone 3 onward.
 *
 * Nothing in this file may ever carry another player's hidden faction. The two
 * places a `Faction` appears below are both exceptions that prove the rule:
 * `round.you` is stripped out of every copy except the one addressed to that
 * player, and `roundOver.reveal` is sent when the round is already decided.
 */
import type { DutyStatus } from './duty';
import type { Faction } from './factions';
import type { HitRegion } from './hitbox';
import type { ItemId } from './inventory';
import type { GroundItem } from './items';
import type { GuardVoiceCue, NpcSnapshot } from './npc';
import type { Role } from './roles';
import type { WeaponId } from './weapons';

/**
 * Where the session is. `lobby` is people milling about waiting for enough of
 * them to start; `active` is a round with a clock and a winner to be had;
 * `over` is the scoreboard, before it drops back to `lobby`.
 */
export type RoundPhase = 'lobby' | 'active' | 'over';

/** Bumped whenever the message shapes change; mismatched clients are rejected. */
export const PROTOCOL_VERSION = 7;

export const NET_CONFIG = {
  port: 3000,

  /** Server broadcast rate. */
  snapshotHz: 30,
  /** How often each client reports its own position. */
  stateHz: 30,

  /**
   * Remote players are drawn this far in the past, so there are always two
   * snapshots to interpolate between and a dropped packet is invisible.
   * One snapshot interval is 33 ms, so this still survives losing two in a row
   * while keeping the visible lag well under a body width at a run.
   */
  interpolationDelayMs: 80,

  /** A client may claim to move this much faster than its role's sprint speed. */
  speedTolerance: 1.6,
  /** Plus this much slack per update, to absorb jitter in packet timing. */
  positionSlackMeters: 0.6,
  /** Generous vertical cap: gravity terminal velocity with room to spare. */
  maxVerticalSpeed: 45,

  /** A socket exceeding this is misbehaving and gets dropped. */
  maxMessagesPerSecond: 150,
  maxNameLength: 16,
  /**
   * Humans per match. The roster (shared/roster.ts) is defined for 2-4 and
   * nothing else: the faction split and the NPC count are both fixed tables, so
   * a fifth player has no seat to sit in.
   */
  maxPlayers: 4,
} as const;

/**
 * Everything about a player that is PUBLIC. Faction is deliberately absent —
 * and so, now, is their chosen name.
 *
 * `name` carries the roster LABEL ("SECRETARY", "GUARD 3"), not what the player
 * typed. The player's own name never leaves the server: knowing that the Doctor
 * is called dave is knowing that the Doctor is a human being, which is exactly
 * the deduction this prototype is trying to make impossible (CLAUDE.md §30).
 */
export type PlayerPublic = {
  id: number;
  /** The public roster label. NOT the player's chosen name. */
  name: string;
  role: Role;
};

export type PlayerSnapshot = {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Facing yaw of the body, radians. */
  yaw: number;
  grounded: boolean;
  sprinting: boolean;
  alive: boolean;
  /**
   * The weapon this player is VISIBLY holding, or null.
   *
   * A concealed weapon is simply absent from the wire — there is no
   * `weaponVisible: false` case carrying a weapon id — so no client can learn
   * what someone is hiding, however it is inspected (CLAUDE.md §14, §16).
   */
  weapon: WeaponId | null;
  /**
   * Publicly denounced by the Telegram Operator's broadcast. Everybody can see
   * it — that is the entire mechanic — and it stays set for the round.
   */
  flagged?: boolean;
};

export type ClientMessage =
  | { t: 'join'; protocol: number; name: string; role: Role }
  /** Position report. Sent at NET_CONFIG.stateHz. */
  | {
      t: 'state';
      x: number;
      y: number;
      z: number;
      yaw: number;
      grounded: boolean;
      sprinting: boolean;
    }
  /**
   * Deliberate discontinuity (respawn / debug teleport) so the move check does
   * not flag it. Milestone 5 removes this: the server will own spawning.
   */
  | { t: 'teleport'; x: number; y: number; z: number }
  /** Dev role cycling (F5). Milestone 5 makes role assignment server-side only. */
  | { t: 'role'; role: Role }
  /**
   * What the player's hands are doing. `weapon` is what is VISIBLY held; a
   * concealed weapon is reported as null and the server never tells anyone.
   */
  | { t: 'weapon'; weapon: WeaponId | null }
  /**
   * A shot. The client sends where it fired from and in what direction; the
   * server does its own raycast and decides what, if anything, was hit. Ammo and
   * reloading stay client-side for the prototype — the server rate-limits by the
   * weapon's own fire interval, which is what actually matters.
   */
  | {
      t: 'fire';
      weapon: WeaponId;
      ox: number;
      oy: number;
      oz: number;
      dx: number;
      dy: number;
      dz: number;
    }
  /** Unarmed strike; direction only, the server knows where the attacker is. */
  | { t: 'melee'; dx: number; dz: number }
  /**
   * "I want that thing on the floor." The server checks you are actually next to
   * it and that nobody else got there first — two players diving for the same
   * pistol must not both come up holding one.
   */
  | { t: 'pickup'; item: number }
  /** Put an item on the floor in front of me. */
  | { t: 'drop'; item: ItemId }
  /** Use a non-weapon item from inventory (medkit heals; document is read). */
  | { t: 'use'; item: ItemId }
  /**
   * "Open or shut that door." A request, not a statement: the server checks the
   * player is alive and actually standing next to it before flipping the bit.
   */
  | { t: 'door'; id: number }
  /** Search a container at this id; server validates proximity and round state. */
  | { t: 'openContainer'; id: number }
  /** Proximity text chat. `broadcast:true` is Telegram Operator only. */
  | { t: 'chat'; text: string; broadcast?: boolean }
  /** Examine a patient to learn what they need. Server validates proximity + hold. */
  | { t: 'examine'; patientId: number }
  /** Treat a patient with a supply item. Server validates you have it. */
  | { t: 'treat'; patientId: number; item: ItemId }
  /** Request a telegram deciphering puzzle. */
  | { t: 'startPuzzle' }
  /** Answer to the current puzzle. */
  | { t: 'puzzleAnswer'; word: string }
  /**
   * Security Officer: begin searching whoever is standing in front of me
   * (CLAUDE.md §16). `target` is a player id or an NPC id — the officer cannot
   * tell them apart, and neither can this message.
   */
  | { t: 'searchStart'; target: number }
  /** End the search without taking anything. */
  | { t: 'searchRelease' }
  /** Take one item off the person currently being searched. */
  | { t: 'confiscate'; item: ItemId }
  /**
   * Telegram Operator: denounce a character to the whole compound. The server
   * checks the report item is in hand and consumes it. Whether `target` is the
   * infiltrator the report named is entirely up to the operator.
   */
  | { t: 'broadcastReport'; target: number }
  | { t: 'respawn' }
  | { t: 'ping'; id: number }
  /** Dev-only: force a full round restart. Server calls startRound immediately. */
  | { t: 'reset' };

export type ServerMessage =
  | {
      t: 'welcome';
      id: number;
      you: PlayerPublic;
      /** Where the server put you. The client must move there before reporting. */
      spawn: { x: number; y: number; z: number };
      players: PlayerPublic[];
      snapshotHz: number;
      health: number;
      maxHealth: number;
      /** Everything currently lying on the floor. */
      items: GroundItem[];
      /** What you are carrying — see the note on the `inventory` message. */
      inventory: ItemId[];
      /** Ids of the doors that are currently open; every other door is shut. */
      doors: number[];
    }
  | { t: 'joined'; player: PlayerPublic }
  | { t: 'left'; id: number }
  | { t: 'role'; id: number; role: Role }
  /** `time` is the server clock in ms; remote rendering is driven off it. */
  | { t: 'snapshot'; time: number; players: PlayerSnapshot[]; npcs: NpcSnapshot[] }
  /**
   * YOUR inventory, sent only to you (CLAUDE.md §16). What someone is carrying is
   * exactly the secret a Security Officer's search is supposed to uncover, so it
   * must never reach anyone else — only the weapon in your visible hand does,
   * via `PlayerSnapshot.weapon`.
   */
  | { t: 'inventory'; items: ItemId[] }
  /** A weapon appeared on the floor — dropped, or spilled from a body. */
  | { t: 'itemAdded'; item: GroundItem }
  /** Somebody picked it up. Deliberately does not say who. */
  | { t: 'itemRemoved'; id: number }
  /**
   * The floor, wholesale. Sent at the start of a round, when the hidden pistols
   * move and everything anybody dropped last round is gone — a stream of
   * `itemRemoved`/`itemAdded` would say the same thing far less clearly.
   */
  | { t: 'itemsReset'; items: GroundItem[] }
  /**
   * The full set of open doors, resent on every change. Seven bits is not worth
   * a delta encoding, and a whole-state message means a client that missed one
   * is right again on the next toggle instead of drifting.
   */
  | { t: 'doors'; open: number[] }
  /**
   * The state of the round.
   *
   * `you` is the single most sensitive field in the protocol: it is filled in
   * ONLY on the copy sent to that one player, and no broadcast path ever sees a
   * message with it set. See RoundSystem.announce.
   */
  | {
      t: 'round';
      phase: RoundPhase;
      /**
       * Seconds left in this phase, not an absolute time: the two machines in a
       * LAN game have no reason to agree on what `Date.now()` is, and a clock
       * that reads 14:59 on one screen and -3:20 on the other is worse than no
       * clock. The client counts down from this and is corrected on the next
       * phase change. 0 in the lobby, which has no deadline.
       */
      secondsLeft: number;
      players: number;
      you?: { faction: Faction };
    }
  /**
   * The Security Officer's patrol assignment (CLAUDE.md §15). Sent to that one
   * player and to nobody else: whether he is keeping up with his duties is
   * something the others are meant to work out by watching where he goes.
   *
   * `null` clears the line — he is not the officer, or there is no round on.
   * `secondsLeft` rather than a deadline, for the same LAN-clock reason as the
   * round message above.
   */
  | { t: 'duty'; duty: DutyStatus | null }
  /**
   * The round is over, so everything can be said out loud. This is the only
   * message that carries anybody else's allegiance, and it exists precisely so
   * players find out afterwards whether they were right.
   */
  | {
      t: 'roundOver';
      winner: Faction;
      reason: string;
      reveal: { id: number; name: string; role: Role; faction: Faction }[];
    }
  /**
   * A guard said something out loud; clients within earshot show it, and play
   * the matching recording if the line has one.
   */
  | { t: 'shout'; id: number; text: string; x: number; z: number; cue?: GuardVoiceCue }
  /** The move check rejected a position; snap back to this one. */
  | { t: 'correction'; x: number; y: number; z: number; reason: string }
  /**
   * YOUR health, sent only to you. Other players' exact health is never
   * transmitted (CLAUDE.md §10) — everyone else gets `alive` and nothing more.
   */
  | { t: 'health'; health: number; maxHealth: number; byId: number }
  /** Somebody fired: origin and where the server's ray actually ended. */
  | {
      t: 'shot';
      id: number;
      weapon: WeaponId;
      ox: number;
      oy: number;
      oz: number;
      hx: number;
      hy: number;
      hz: number;
    }
  /** Somebody threw a punch, for the animation. */
  | { t: 'swing'; id: number }
  /**
   * A melee hit landed on this id and the victim survived — play the stagger
   * animation and freeze them briefly. NOT sent on a kill: a death plays its own
   * clip and must not be interrupted.
   */
  | { t: 'struck'; id: number }
  /** Hit confirmation, to the attacker only. */
  | { t: 'hitmark'; region: HitRegion | 'melee'; lethal: boolean }
  | {
      t: 'death';
      id: number;
      byId: number;
      cause: WeaponId | 'melee';
      region: HitRegion | null;
    }
  | { t: 'spawned'; id: number; x: number; y: number; z: number }
  | { t: 'pong'; id: number }
  | { t: 'reject'; reason: string }
  /** Private notification to one player only — not a guard shout. */
  | { t: 'alert'; text: string }
  /** A container was searched; `items` lists what was inside (empty = nothing). */
  | { t: 'container'; id: number; items: ItemId[] }
  /** Proximity or broadcast chat message from another player. */
  | { t: 'chatMsg'; from: number; name: string; text: string; channel: 'local' | 'broadcast' }
  /** Minimap noise event for gunshots, melee, door interactions. */
  | { t: 'noise'; x: number; z: number; kind: 'gunshot' | 'melee' | 'door' }
  /** Public patient status (everyone sees wounded/critical/dead, not need). */
  | { t: 'patients'; patients: { id: number; status: string }[] }
  /** Private: what a patient needs — only sent to the examiner. */
  | { t: 'examine'; patientId: number; need: string }
  /** Compound-wide patient death announcement. */
  | { t: 'announce'; text: string }
  /** A telegram deciphering puzzle for the operator (sent privately). */
  | { t: 'puzzle'; id: number; scrambled: string }
  /**
   * A search started or ended. Sent to everyone nearby, because two people
   * standing perfectly still together is a PUBLIC event and half the value of
   * the mechanic is bystanders seeing it happen (CLAUDE.md §16).
   *
   * `items` is the asymmetry: it is filled in ONLY on the copy addressed to the
   * officer. Nobody else — including the person being searched — is told what
   * was found, which is what lets an officer lie about it.
   */
  | {
      t: 'search';
      phase: 'begin' | 'end';
      officer: number;
      target: number;
      items?: ItemId[];
    }
  /**
   * The signals report, sent privately to the Telegram Operator when he reads
   * the report item. `truth` is always a real infiltrator — the intelligence
   * does not lie. Only the broadcast the operator makes from it can.
   */
  | {
      t: 'report';
      truth: number;
      candidates: { id: number; label: string }[];
    }
  /** Somebody has been publicly denounced. Everyone is told, permanently. */
  | { t: 'flagged'; id: number; label: string };

/** Parse without ever throwing on a malformed or hostile frame. */
export function decode<T>(raw: string): T | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    if (typeof (value as { t?: unknown }).t !== 'string') return null;
    return value as T;
  } catch {
    return null;
  }
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Keeps JSON small and snapshots stable; 1 mm precision is far more than enough. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
