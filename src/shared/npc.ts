/**
 * Guards and the General (CLAUDE.md §17–§22, §25).
 *
 * Shared, like combat: the server owns the real NpcWorld and offline solo mode
 * runs an identical one locally, so the mandatory §37 guard test can be done by
 * one person with no second machine.
 *
 * Guards are deliberately stupid. They are not detectives and they do not try to
 * work out who the infiltrators are. They answer exactly one question:
 *
 *     "Is that person holding a weapon they are not allowed to hold, and can I
 *      actually see it?"
 *
 * The first half is `canBrandish` in shared/weapons.ts — the single authorisation
 * rule, never re-implemented here. The second half is a raycast against the same
 * wall data the client renders, which is what makes the map matter: a pistol
 * pulled behind a wall is a pistol the guard never saw.
 */
import { resolveShot, type CombatTarget } from './combat';
import { moveBody, raycastColliders, standingClear, type Actor, type Body } from './collision';
import { GAME_CONFIG } from './constants';
import type { DoorField } from './doors';
import { HIT_CLASS, type HitRegion } from './hitbox';
import type { GroundItem, ItemField } from './items';
import {
  COMPOUND,
  GENERAL_POST,
  GUARD_POSTS,
  PATIENT_POSTS,
  ROLE_ROUTINES,
  restrictedZoneAt,
  type RoutineStop,
  type ZoneResponse,
} from './mapData';
import { clearLine, findPath, pathLength, walkable, type NavPoint } from './navgrid';
import { ROLE_STATS, type Role } from './roles';
import { labelRoster } from './roster';
import type { Collider, Vec3 } from './types';
import { isWeaponItem, type ItemId } from './inventory';
import { canBrandish, WEAPONS, type WeaponId } from './weapons';

const cfg = GAME_CONFIG.guards;
const gen = GAME_CONFIG.general;

/**
 * Which BRAIN an NPC runs — not who it is. Identity is `Npc.role`, because
 * after the roster change a doctor may be a person or a routine and the label
 * over their head must not say which (CLAUDE.md §30).
 *
 * `staff` is the routine brain: walk a short fixed loop, stand at each stop for
 * a while, react to nothing. It covers the NPC Doctor, Secretary and Telegram
 * Operator.
 */
export type NpcKind = 'guard' | 'general' | 'patient' | 'staff';

/**
 * PATROL → SUSPICIOUS → WARNING → HOSTILE (CLAUDE.md §19), plus INVESTIGATING:
 * a guard who heard something, or who lost sight of someone, walking over to
 * look. Public: a guard squaring up and raising his rifle is something
 * bystanders can see, and seeing it is half the point — "why did the guard
 * start shooting her?"
 */
export type GuardMode = 'patrol' | 'investigating' | 'suspicious' | 'warning' | 'hostile';

/** NPC ids live above every player id so the two can never collide. */
export const NPC_ID_BASE = 10_000;

export const NPC_STATS = {
  /**
   * Guards are tougher than the average clerk but not bullet sponges: a pistol
   * still takes two torso hits, a rifle one.
   */
  guard: { maxHealth: 120, color: 0x3f4a38, headColor: 0xb59672 },
  general: { maxHealth: 100, color: 0x7a2f2f, headColor: 0xc2a882 },
  patient: { maxHealth: 50, color: 0xd4c8b0, headColor: 0xc2a882 },
  staff: { maxHealth: 80, color: 0x3a4a5a, headColor: 0xb59672 },
} as const;

/** The guard's own weapon. Guards are authorised, so carrying it openly is normal. */
export const GUARD_WEAPON: WeaponId = 'rifle';

/** What the guard brain can perceive about a person. */
export type Perceivable = {
  id: number;
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  role: Role;
  alive: boolean;
  /**
   * The weapon they are VISIBLY holding, or null. Concealment is an absence, so
   * a hidden pistol is not something a guard can even be told about.
   */
  weapon: WeaponId | null;
  /**
   * Whether this person's role still buys them entry to a restricted zone.
   *
   * Only the Secretary can lose it, by missing her deliveries often enough
   * (shared/duty.ts). Modelled as a flag on the person rather than as a second
   * zone rule so that a banned Secretary is challenged by exactly the machinery
   * that would challenge a Doctor at the same door — one enforcement path, not
   * two. Absent means allowed, so nothing that does not care has to say so.
   */
  hqAccess?: boolean;
};

export type NpcSnapshot = {
  id: number;
  kind: NpcKind;
  /** Public occupation. Drives the model and the nametag. */
  role: Role;
  /** The public roster label — "DOCTOR", "GUARD 3". Never a name. */
  label: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  mode: GuardMode;
  /** Non-null while the guard has his weapon up, so clients can draw it raised. */
  aiming: boolean;
  /** The weapon this NPC is visibly carrying, or null (dead, unarmed, concealed). */
  weapon: WeaponId | null;
  /** Patients lie down; everyone else stands. */
  pose: 'stand' | 'lie';
  /** Publicly denounced by the Telegram Operator. Visible to everyone. */
  flagged?: boolean;
};

/**
 * Which recorded line a guard's shout plays, if any. The text is what a nearby
 * player READS; the cue is what they HEAR, and the two are the same event —
 * there is no second channel for audio. Assets are in
 * assets/sounds/guard_voiceovers, several per cue, picked at random per event.
 */
export type GuardVoiceCue = 'looking' | 'warn' | 'hostile' | 'threat_neutralized';

export type NpcEvent =
  | { t: 'shout'; id: number; text: string; x: number; z: number; cue?: GuardVoiceCue }
  | { t: 'shot'; id: number; weapon: WeaponId; origin: Vec3; end: Vec3 }
  | { t: 'hit'; id: number; targetId: number; region: HitRegion; damage: number }
  /** Guard picked up a dropped weapon. Clients remove it from the floor view. */
  | { t: 'took'; id: number; itemId: number };

type Npc = {
  id: number;
  kind: NpcKind;
  /** Public occupation — what the nametag and the character model come from. */
  role: Role;
  label: string;
  body: Body;
  yaw: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Waypoint loop; a single-entry route is a static post. */
  route: readonly { x: number; z: number }[];
  waypoint: number;
  postYaw: number;
  mode: GuardMode;
  targetId: number | null;
  /** Seconds the current offence has been continuously visible. */
  seenFor: number;
  /** Seconds spent in the current mode. */
  modeTimer: number;
  /** Seconds since the target was last actually seen. */
  lostSight: number;
  nextShotAt: number;
  /** Hostile because it was attacked, not because of a visible weapon. */
  provoked: boolean;
  /**
   * Player ids this guard has already decided about. A grudge outlives losing
   * sight, outlives the offence being tidied away, and outlives him walking
   * back to his post: once he has been pushed all the way to HOSTILE by you,
   * seeing you again is enough, with no second warning. Cleared only when the
   * round resets or the man is dealt with (`forget`).
   */
  grudges: Set<number>;
  /** Where the target was last actually seen; where he goes to look. */
  lastKnown: { x: number; z: number } | null;
  /** The spot he is walking to look at (a noise, or a last known position). */
  investigate: { x: number; z: number } | null;
  /** Seconds spent standing AT the investigation spot, looking round. */
  investigateTimer: number;
  /**
   * The direction he walked in on, and the centre of the head sweep he does
   * when he gets there. Looking onward past the spot is how a man who came to
   * find out what the noise was actually stands.
   */
  investigateBearing: number;
  /**
   * A noise a POSTED guard heard. He does not go and look — he turns and looks,
   * which swings his vision cone off the door he is watching and is the whole
   * reason a man shooting at his back now gets spotted.
   */
  alertLook: { x: number; z: number } | null;
  alertLookTimer: number;
  /**
   * Seconds he will give the current investigation before writing it off.
   * Computed from the route he actually has to walk, not a flat constant: a
   * shot at the far end of the compound is a fifteen-second walk, and giving up
   * halfway there looked exactly like the wall-bumping it replaced.
   */
  investigateDeadline: number;
  /** Cached route to `pathGoal`. Null means walk straight at it and hope. */
  path: NavPoint[] | null;
  pathGoal: NavPoint | null;
  /** Seconds until the route is recomputed. */
  repathIn: number;
  /** Seconds spent trying to move and not moving. See `step`. */
  stuckFor: number;
  /** Rate limit on the forced repaths that stuckness triggers. */
  stuckRepathIn: number;
  /** General only: the spot he is putting between himself and the threat. */
  cover: NavPoint | null;
  coverTimer: number;
  /** General only. Twice bitten and he stops hiding and runs. */
  hitsTaken: number;
  /**
   * Server clock ms at which a stun wears off. A melee hit that does not kill
   * freezes the NPC in place for `stunDuration` seconds: movement and shooting
   * are blocked while nowMs < stunnedUntil.
   */
  stunnedUntil: number;
  /** Weapons this guard confiscated from the floor; dropped on death. */
  carried: WeaponId[];
  /**
   * Active retrieve goal: walk to a dropped item and pick it up. Cleared when
   * the item is gone, the deadline passes, or the guard stops being calm.
   */
  retrieve: { itemId: number; x: number; z: number; until: number } | null;
  /** Unarmed orderly: shouts and calls guards, but does not shoot. */
  unarmed: boolean;
  /**
   * A staff NPC's daily round, or null for everyone else. See `tickStaff`.
   */
  routine: readonly RoutineStop[] | null;
  /** Index into `routine` of the stop currently being walked to or stood at. */
  routineStop: number;
  /** Seconds left standing at the current stop. Zero means "still walking". */
  dwell: number;
  /** Denounced by the Telegram Operator's broadcast; set for the round. */
  flagged: boolean;
};

const EYE = 1.55;
const CHEST = 1.15;
const TURN_RATE = 5.0; // rad/s

/**
 * The single gap in the HQ wall. Where a threat he never actually saw must have
 * come from, and where he runs when the room stops being safe.
 */
const HQ_DOOR: NavPoint = { x: 0, z: -12 };

let coverCache: NavPoint[] | null = null;

/**
 * Standing positions around the only things in the General's office tall enough
 * to stop a bullet: the two pillars and the two filing cabinets. His desk is
 * 0.95 m and the briefing table 0.8 m — you can put either between yourself and
 * a rifle and still be shot over it, so they are not cover and are never
 * offered as any. Static map geometry, so computed once.
 */
function coverSpots(): NavPoint[] {
  if (coverCache) return coverCache;

  const radius = GAME_CONFIG.player.radius;
  const pad = radius + gen.coverStandoff;
  const out: NavPoint[] = [];

  for (const c of COMPOUND.colliders) {
    if (c.kind !== 'prop') continue;
    if (c.max.y - c.min.y < gen.coverMinHeight) continue;
    const cx = (c.min.x + c.max.x) / 2;
    const cz = (c.min.z + c.max.z) / 2;
    // Only what is in the room with him. He is not going to sprint across the
    // compound to a crate in Storage.
    if (restrictedZoneAt(cx, cz)?.response !== 'shoot') continue;

    const x0 = c.min.x - pad;
    const x1 = c.max.x + pad;
    const z0 = c.min.z - pad;
    const z1 = c.max.z + pad;
    // Faces and corners: eight ways round a box is enough resolution to shuffle
    // as someone circles it, and few enough to re-score every 0.7 s for free.
    const ring = [
      { x: cx, z: z0 }, { x: cx, z: z1 }, { x: x0, z: cz }, { x: x1, z: cz },
      { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x0, z: z1 }, { x: x1, z: z1 },
    ];
    for (const p of ring) {
      if (standingClear(p.x, p.z, radius, COMPOUND.colliders)) out.push(p);
    }
  }

  coverCache = out;
  return out;
}

function makeBody(x: number, z: number): Body {
  return {
    position: { x, y: 0, z },
    velocity: { x: 0, y: 0, z: 0 },
    radius: GAME_CONFIG.player.radius,
    height: GAME_CONFIG.player.height,
    grounded: true,
  };
}

/** Yaw that faces the given XZ direction. Yaw 0 looks north (-Z). */
function yawTowards(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Where THIS guard stands to look at a noise. Every responder paths to the same
 * square metre otherwise, and the last ones to arrive spend the whole linger
 * shouldering the first ones out of the way in the doorway.
 *
 * Deterministic in the guard's id, so the server and offline solo mode place
 * them identically with nothing to synchronise, and only used if the offset spot
 * is somewhere a body fits and can be reached from the noise without going
 * through a wall — otherwise the noise itself is close enough.
 */
function spreadSpot(npc: Npc, at: NavPoint): NavPoint {
  const angle = (npc.id % 8) * (Math.PI / 4);
  const out = {
    x: at.x + Math.cos(angle) * cfg.investigateSpread,
    z: at.z + Math.sin(angle) * cfg.investigateSpread,
  };
  return walkable(out.x, out.z) && clearLine(at, out) ? out : at;
}

/**
 * One character the compound has to staff itself with, as dealt by
 * `shared/roster.ts`. A seat is deliberately just an occupation and the public
 * label that goes above its head: nothing here says which brain will run it,
 * because a Guard seat filled by an NPC and one filled by a human must be
 * indistinguishable to everyone watching (CLAUDE.md §30).
 */
export type NpcSeat = { role: Role; label: string };

/**
 * The roster with no humans in it: every singleton role plus a full guard
 * detail. This is what offline solo mode and the guard tests see, and it is
 * also what the compound looks like before any player has taken a seat off it.
 */
export function defaultSeats(): NpcSeat[] {
  const roles: Role[] = ['doctor', 'secretary', 'telegram'];
  while (roles.length < 11) roles.push('guard');
  const labels = labelRoster(roles, (r) => ROLE_STATS[r].name);
  return roles.map((role, i) => ({ role, label: labels[i]! }));
}

type NpcOptions = {
  id: number;
  kind: NpcKind;
  role: Role;
  label: string;
  x: number;
  z: number;
  yaw: number;
  maxHealth: number;
  route: readonly { x: number; z: number }[];
  waypoint: number;
  unarmed: boolean;
  routine?: readonly RoutineStop[] | null;
  dwell?: number;
};

/**
 * Build one NPC. Everything an NPC needs to exist that is not about WHO it is —
 * the whole threat brain's worth of timers, grudges and path caches — is the
 * same zeroed state for all four kinds, so it lives here once instead of in
 * four near-identical object literals inside `reset`.
 */
function makeNpc(o: NpcOptions): Npc {
  return {
    id: o.id,
    kind: o.kind,
    role: o.role,
    label: o.label,
    body: makeBody(o.x, o.z),
    yaw: o.yaw,
    health: o.maxHealth,
    maxHealth: o.maxHealth,
    alive: true,
    route: o.route,
    waypoint: o.waypoint,
    postYaw: o.yaw,
    mode: 'patrol',
    targetId: null,
    seenFor: 0,
    modeTimer: 0,
    lostSight: 0,
    nextShotAt: 0,
    provoked: false,
    grudges: new Set(),
    lastKnown: null,
    investigate: null,
    investigateTimer: 0,
    investigateBearing: o.yaw,
    alertLook: null,
    alertLookTimer: 0,
    investigateDeadline: 0,
    path: null,
    pathGoal: null,
    repathIn: 0,
    stuckFor: 0,
    stuckRepathIn: 0,
    cover: null,
    coverTimer: 0,
    hitsTaken: 0,
    stunnedUntil: 0,
    carried: [],
    retrieve: null,
    unarmed: o.unarmed,
    routine: o.routine ?? null,
    routineStop: 0,
    dwell: o.dwell ?? 0,
    flagged: false,
  };
}

export class NpcWorld {
  private readonly npcs: Npc[] = [];
  private nextId = NPC_ID_BASE;
  /** Last clock the world was ticked with — see `provoke`. */
  private nowMs = 0;
  /**
   * Events raised outside `tick` — `hearNoise` is called by the combat code,
   * not by the guard loop, so it has no events array to push into. Drained by
   * the next tick, which is the frame the reaction happens on anyway.
   */
  private pending: NpcEvent[] = [];

  constructor() {
    this.reset();
  }

  /**
   * Rebuild every NPC at full health, back on post. Used by F8 and round start.
   *
   * `seats` is the NPC half of the round's roster (shared/roster.ts): one entry
   * per character the compound has to staff itself, already labelled by the
   * caller so that guard numbering runs across humans and NPCs together. The
   * default is the whole compound with no humans in it, which is what offline
   * solo mode wants and what the guard tests assert against.
   *
   * The four HQ posts are filled FIRST and out of the NPC pool only. A human
   * Guard can be posted anywhere except the ring around the General, so that
   * ring has to be manned before anything else is.
   */
  reset(seats: readonly NpcSeat[] = defaultSeats()): void {
    this.npcs.length = 0;
    this.pending.length = 0;
    this.nextId = NPC_ID_BASE;

    const guardSeats = seats.filter((s) => s.role === 'guard');
    const staffSeats = seats.filter((s) => s.role !== 'guard');

    // HQ posts first, then the field posts from the far end — human Guards are
    // spawned from the near end (GUARD_SPAWNS), so the two never collide.
    const hqPosts = GUARD_POSTS.filter((p) => p.hq);
    const fieldPosts = GUARD_POSTS.filter((p) => !p.hq);
    const posts = [...hqPosts, ...[...fieldPosts].reverse()];

    for (let i = 0; i < guardSeats.length; i++) {
      const post = posts[i % posts.length]!;
      const start = post.route[0]!;
      this.npcs.push(
        makeNpc({
          id: this.nextId++,
          kind: 'guard',
          role: 'guard',
          label: guardSeats[i]!.label,
          x: start.x,
          z: start.z,
          yaw: post.yaw ?? 0,
          maxHealth: NPC_STATS.guard.maxHealth,
          route: post.route,
          waypoint: post.route.length > 1 ? 1 : 0,
          unarmed: post.unarmed ?? false,
        }),
      );
    }

    for (const seat of staffSeats) {
      const routine = ROLE_ROUTINES[seat.role] ?? null;
      const start = routine?.[0] ?? { x: 0, z: 8 };
      this.npcs.push(
        makeNpc({
          id: this.nextId++,
          kind: 'staff',
          role: seat.role,
          label: seat.label,
          x: start.x,
          z: start.z,
          yaw: routine?.[0]?.yaw ?? 0,
          maxHealth: NPC_STATS.staff.maxHealth,
          route: [{ x: start.x, z: start.z }],
          waypoint: 0,
          // Clerks and medics do not shoot. They are shootable, which is all a
          // prototype needs from them.
          unarmed: true,
          routine,
          // Start dwelling, so the first thing a player sees them do is the
          // thing their job looks like rather than a walk from nowhere.
          dwell: routine?.[0]?.seconds ?? 0,
        }),
      );
    }

    this.npcs.push(
      makeNpc({
        id: this.nextId++,
        kind: 'general',
        role: 'security',
        label: 'THE GENERAL',
        x: GENERAL_POST.x,
        z: GENERAL_POST.z,
        yaw: GENERAL_POST.yaw,
        maxHealth: NPC_STATS.general.maxHealth,
        route: [{ x: GENERAL_POST.x, z: GENERAL_POST.z }],
        waypoint: 0,
        unarmed: false,
      }),
    );

    // Static patients in the medical ward — no brain, no patrol.
    for (const post of PATIENT_POSTS) {
      this.npcs.push(
        makeNpc({
          id: this.nextId++,
          kind: 'patient',
          role: 'doctor',
          label: 'PATIENT',
          x: post.x,
          z: post.z,
          yaw: 0,
          maxHealth: NPC_STATS.patient.maxHealth,
          route: [post],
          waypoint: 0,
          unarmed: true,
        }),
      );
    }
  }

  /** The two ward patients, in the order PatientSystem should track them. */
  get patientIds(): number[] {
    return this.npcs.filter((n) => n.kind === 'patient').map((n) => n.id);
  }

  get generalId(): number {
    return this.npcs.find((n) => n.kind === 'general')?.id ?? -1;
  }

  get generalAlive(): boolean {
    return this.npcs.find((n) => n.kind === 'general')?.alive ?? false;
  }

  snapshots(): NpcSnapshot[] {
    return this.npcs.map((n) => ({
      id: n.id,
      kind: n.kind,
      role: n.role,
      label: n.label,
      x: n.body.position.x,
      y: n.body.position.y,
      z: n.body.position.z,
      yaw: n.yaw,
      alive: n.alive,
      mode: n.mode,
      flagged: n.flagged || undefined,
      aiming: n.kind === 'guard' && n.alive && (n.mode === 'warning' || n.mode === 'hostile'),
      weapon: n.kind === 'guard' && n.alive && !n.unarmed ? GUARD_WEAPON : null,
      pose: n.kind === 'patient' ? 'lie' : 'stand',
    }));
  }

  /** NPCs as things that can be shot. */
  combatTargets(): CombatTarget[] {
    return this.npcs.map((n) => ({
      id: n.id,
      x: n.body.position.x,
      y: n.body.position.y,
      z: n.body.position.z,
      yaw: n.yaw,
      alive: n.alive,
    }));
  }

  /** NPCs as things that get in your way. */
  actors(): Actor[] {
    const out: Actor[] = [];
    for (const n of this.npcs) {
      if (!n.alive) continue;
      out.push({
        x: n.body.position.x,
        y: n.body.position.y,
        z: n.body.position.z,
        radius: n.body.radius,
        height: n.body.height,
      });
    }
    return out;
  }

  has(id: number): boolean {
    return this.npcs.some((n) => n.id === id);
  }

  info(id: number): { kind: NpcKind; label: string; alive: boolean } | null {
    const n = this.npcs.find((x) => x.id === id);
    return n ? { kind: n.kind, label: n.label, alive: n.alive } : null;
  }

  /**
   * Take a hit. Returns whether it was fatal, or null if `id` is not an NPC.
   * Shooting a guard provokes every guard who could plausibly have noticed —
   * you do not get to pick them off one at a time in a corridor.
   */
  applyDamage(
    id: number,
    amount: number,
    byId: number,
    from?: { x: number; z: number },
  ): { killed: boolean; kind: NpcKind; drops: WeaponId[] } | null {
    const npc = this.npcs.find((n) => n.id === id);
    if (!npc || !npc.alive) return null;

    npc.health = Math.max(0, npc.health - amount);
    const killed = npc.health === 0;
    if (killed) npc.alive = false;

    if (npc.kind === 'general') {
      npc.hitsTaken++;
      this.alarmGeneral(npc, byId, from ?? null);
    }

    const at = { x: npc.body.position.x, z: npc.body.position.z };
    this.provoke(
      byId,
      at,
      killed ? cfg.provokeRadiusOnKill : cfg.provokeRadiusOnHit,
      from,
    );

    // A dead guard drops his issued weapon plus anything he confiscated.
    const drops: WeaponId[] = [];
    if (killed && npc.kind === 'guard') {
      drops.push(GUARD_WEAPON, ...npc.carried);
      npc.carried = [];
    }
    return { killed, kind: npc.kind, drops };
  }

  /**
   * Freeze an NPC for `seconds`. Called by CombatSystem (and offline Game.strike)
   * when a melee hit lands but does not kill — a kill plays its own clip and must
   * not be overridden. No-op if the id is not an NPC or the NPC is already dead.
   */
  stun(id: number, seconds: number): void {
    const npc = this.npcs.find((n) => n.id === id);
    if (!npc || !npc.alive) return;
    npc.stunnedUntil = Math.max(npc.stunnedUntil, this.nowMs + seconds * 1000);
  }

  /** Where an NPC is, or null if the id is not one. Used to check search reach. */
  positionOf(id: number): { x: number; z: number } | null {
    const npc = this.npcs.find((n) => n.id === id);
    return npc ? { x: npc.body.position.x, z: npc.body.position.z } : null;
  }

  /** The public label of an NPC, for announcements naming a character. */
  labelOf(id: number): string | null {
    return this.npcs.find((n) => n.id === id)?.label ?? null;
  }

  /**
   * Kill an NPC without provoking anybody (contrast `applyDamage`).
   *
   * A patient who dies of neglect has not been attacked, so nothing about it
   * should make the compound's guards hostile toward anyone — but the body must
   * still lie down, or the ward keeps a corpse standing at its bedside for the
   * rest of the round. Returns false if the id is not a live NPC.
   */
  expire(id: number): boolean {
    const npc = this.npcs.find((n) => n.id === id);
    if (!npc || !npc.alive) return false;
    npc.health = 0;
    npc.alive = false;
    return true;
  }

  /**
   * What a Security Officer finds when he searches an NPC (CLAUDE.md §16).
   *
   * An armed guard is holding his issued rifle, plus anything he picked up off
   * the floor. Everyone else is carrying nothing — which is itself information,
   * because a searched NPC and a searched player produce the same shaped answer
   * and the officer cannot tell from the result which he just stopped.
   */
  itemsOf(id: number): ItemId[] {
    const npc = this.npcs.find((n) => n.id === id);
    if (!npc || !npc.alive) return [];
    const out: ItemId[] = [];
    if (npc.kind === 'guard' && !npc.unarmed) out.push(GUARD_WEAPON);
    out.push(...npc.carried);
    return out;
  }

  /** Take one item off an NPC. Returns false if he does not have it. */
  confiscate(id: number, item: ItemId): boolean {
    const npc = this.npcs.find((n) => n.id === id);
    if (!npc || !npc.alive) return false;
    const i = npc.carried.indexOf(item as WeaponId);
    if (i >= 0) {
      npc.carried.splice(i, 1);
      return true;
    }
    // His issued rifle: taking it disarms him for the rest of the round, which
    // is a real decision for the officer rather than free loot.
    if (item === GUARD_WEAPON && npc.kind === 'guard' && !npc.unarmed) {
      npc.unarmed = true;
      return true;
    }
    return false;
  }

  /**
   * Mark an NPC as denounced by the Telegram Operator's broadcast. Purely a
   * label — guard grudges are keyed to player ids, so a flagged NPC is hunted
   * by the humans who believed the broadcast and by nobody else.
   */
  setFlagged(id: number): boolean {
    const npc = this.npcs.find((n) => n.id === id);
    if (!npc) return false;
    npc.flagged = true;
    return true;
  }

  /** Every character in the compound, for the report's candidate list. */
  get rosterEntries(): { id: number; label: string; role: Role }[] {
    return this.npcs
      .filter((n) => n.kind === 'guard' || n.kind === 'staff')
      .map((n) => ({ id: n.id, label: n.label, role: n.role }));
  }

  /**
   * Make every guard within `radius` of `at` hostile toward `attackerId`.
   * `lastKnown` is where guards will walk — defaults to `at` (the victim's
   * position) but callers that know the shooter's position pass it so guards
   * face the right way instead of crowding around the corpse.
   */
  provoke(
    attackerId: number,
    at: { x: number; z: number },
    radius: number,
    lastKnown?: { x: number; z: number },
  ): void {
    const dest = lastKnown ?? at;
    for (const n of this.npcs) {
      if (n.kind !== 'guard' || !n.alive) continue;
      if (Math.hypot(n.body.position.x - at.x, n.body.position.z - at.z) > radius) continue;
      n.provoked = true;
      n.targetId = attackerId;
      n.grudges.add(attackerId);
      n.lastKnown = { x: dest.x, z: dest.z };
      n.lostSight = 0;
      // Through setMode, and only if he was not already hostile: it is what owes
      // the shooter a reaction delay. Setting the mode by hand here left every
      // provoked guard with a stale nextShotAt, so the entire compound fired on
      // the same frame the first shot landed — no warning, no beat to run.
      if (n.mode !== 'hostile') this.setMode(n, 'hostile', this.nowMs);
    }
  }

  /**
   * Instantly hostile response to a door-access violation — no warning, because
   * the rule is posted. Every guard within `doorViolationRadius` turns on the
   * offender immediately.
   */
  reportViolation(playerId: number, at: { x: number; z: number }): void {
    this.provoke(playerId, at, cfg.doorViolationRadius, at);
  }

  /**
   * A noise everyone nearby can hear (CLAUDE.md §17 — gunfire is the most
   * obvious event in the compound). It does not say WHO: patrolling guards walk
   * over to look, and whatever they find when they arrive is judged on its own.
   *
   * Static sentries do NOT bite. A door sentry who abandoned his post every time
   * a shot went off somewhere would just be a lever for emptying the corridor
   * outside the General's office. They do TURN, though: three of them stood
   * facing HQ while a player shot at their backs from the other direction, which
   * was not stoicism — nothing in here ever pointed them at a noise at all.
   */
  hearNoise(x: number, z: number, radius: number): void {
    for (const n of this.npcs) {
      if (!n.alive) continue;
      if (n.kind === 'general') {
        // The one that makes "shot AT" work rather than only "shot": a round
        // that goes past his ear leaves no damage event behind. He does not go
        // and look, the way a guard would. He gets behind something.
        const atHim =
          restrictedZoneAt(x, z)?.response === 'shoot' ||
          Math.hypot(n.body.position.x - x, n.body.position.z - z) <= gen.alarmRadius;
        if (atHim) this.alarmGeneral(n, null, { x, z });
        continue;
      }
      if (n.kind !== 'guard') continue;
      if (n.mode !== 'patrol' && n.mode !== 'investigating') continue;
      if (Math.hypot(n.body.position.x - x, n.body.position.z - z) > radius) continue;

      // Men who hold their post: the sentries on a single-point route, and the
      // General's own detail, who are in that room for one reason and a noise
      // somewhere else is not it. Their feet stay where they are; their heads
      // do not.
      const posted =
        n.route.length <= 1 ||
        restrictedZoneAt(n.route[0].x, n.route[0].z)?.response === 'shoot';
      if (posted) {
        n.alertLook = { x, z };
        n.alertLookTimer = cfg.alertLookDuration;
        continue;
      }

      this.beginInvestigation(n, { x, z });
      this.pending.push(this.shout(n, 'What was that?', 'looking'));
    }
  }

  /**
   * Drop every grudge against a player. Called when they respawn: being shot
   * settles the account, and a permanent shoot-on-sight mark would take a
   * playtester out of the round for good.
   */
  forget(playerId: number): void {
    for (const n of this.npcs) {
      n.grudges.delete(playerId);
      if (n.targetId === playerId) this.standDown(n);
    }
  }

  /** Debug/testing: does this guard want that player dead on sight? */
  holdsGrudge(guardId: number, playerId: number): boolean {
    return this.npcs.find((n) => n.id === guardId)?.grudges.has(playerId) ?? false;
  }

  /**
   * `colliders` should be `doors.solids()` where doors exist, so guards cannot
   * see or shoot through a shut one. `doors` itself is optional and separate,
   * because passing it does something the collider list cannot express: guards
   * PUSH DOORS OPEN as they reach them. That is the whole reason the nav grid is
   * allowed to stay blind to doors — see the note at the top of navgrid.ts.
   * Omit it (the guard tests do) and the compound behaves as if it had none.
   */
  tick(
    dt: number,
    nowMs: number,
    people: readonly Perceivable[],
    colliders: readonly Collider[],
    doors?: DoorField,
    items?: ItemField,
  ): NpcEvent[] {
    // Remembered so damage arriving between ticks (provoke) can schedule against
    // the same clock the shooting code reads.
    this.nowMs = nowMs;
    const events: NpcEvent[] = this.pending;
    this.pending = [];
    const reach = GAME_CONFIG.world.guardDoorOpenRadius;
    for (const npc of this.npcs) {
      if (!npc.alive) continue;
      if (nowMs < npc.stunnedUntil) continue; // frozen by a melee hit
      if (npc.kind === 'patient') continue; // bedridden, no brain
      if (npc.kind === 'staff') this.tickStaff(npc, dt, colliders);
      else if (npc.kind === 'general') this.tickGeneral(npc, dt, people, colliders);
      else this.tickGuard(npc, dt, nowMs, people, colliders, events, items);
      // Who may push the ONE restricted door (the General's HQ) open: a guard
      // who is chasing somebody, and the Secretary, whose entire job is
      // carrying paper through it. A guard on his rounds leaves it alone, and
      // so does everybody else — the door is only meaningful while it is shut.
      const mayForce = npc.mode !== 'patrol' || npc.role === 'secretary';
      doors?.openNear(npc.body.position.x, npc.body.position.z, reach, mayForce);
    }
    return events;
  }

  // ---------------------------------------------------------------- internals

  /**
   * The daily round of a Doctor, Secretary or Telegram Operator NPC.
   *
   * Deliberately the whole brain. Staff do not look at anybody, do not notice
   * weapons, do not investigate noises and never shoot — they walk their loop
   * and stand where the loop says to stand. That restraint is the point: a
   * player watching the ward for thirty seconds must be able to describe what a
   * normal Doctor does, because that description is the baseline against which
   * a HUMAN doctor's deviation reads as suspicious (CLAUDE.md §34).
   */
  private tickStaff(npc: Npc, dt: number, colliders: readonly Collider[]): void {
    const routine = npc.routine;
    if (!routine || routine.length === 0) {
      this.turnTowards(npc, npc.postYaw, dt);
      this.step(npc, 0, 0, 0, dt, colliders);
      return;
    }

    const stop = routine[npc.routineStop % routine.length]!;

    if (npc.dwell > 0) {
      npc.dwell -= dt;
      // Facing matters while standing still — it is the difference between a
      // clerk working at a console and a man staring at a wall.
      this.turnTowards(npc, stop.yaw ?? npc.postYaw, dt);
      this.step(npc, 0, 0, 0, dt, colliders);
      return;
    }

    const d = Math.hypot(stop.x - npc.body.position.x, stop.z - npc.body.position.z);
    if (d <= cfg.waypointReach) {
      const jitter = stop.jitter ?? 0;
      npc.dwell = Math.max(1, stop.seconds + (Math.random() * 2 - 1) * jitter);
      npc.postYaw = stop.yaw ?? npc.yaw;
      npc.routineStop = (npc.routineStop + 1) % routine.length;
      this.dropRoute(npc);
      this.step(npc, 0, 0, 0, dt, colliders);
      return;
    }

    this.navigate(npc, stop, dt, colliders, cfg.patrolSpeed, true);
  }

  private tickGuard(
    npc: Npc,
    dt: number,
    nowMs: number,
    people: readonly Perceivable[],
    colliders: readonly Collider[],
    events: NpcEvent[],
    items?: ItemField,
  ): void {
    npc.modeTimer += dt;
    if (npc.alertLookTimer > 0) npc.alertLookTimer -= dt;

    const current = npc.targetId != null ? people.find((p) => p.id === npc.targetId) : undefined;
    const visible = current && this.canSee(npc, current, colliders) ? current : undefined;
    npc.lostSight = visible ? 0 : npc.lostSight + dt;
    if (visible) npc.lastKnown = { x: visible.x, z: visible.z };

    // What the man we are watching is doing wrong, if we can see him at all.
    const offence = visible ? offenceOf(visible) : null;
    // Complying means being SEEN to comply. An offender who steps behind a wall
    // has not put anything away as far as the guard is concerned.
    const complied = !!visible && offence === null;

    if (npc.mode === 'patrol' || npc.mode === 'investigating') {
      npc.provoked = false;

      // A face he has already been pushed all the way to hostility by. No
      // reaction delay and no second warning: he remembers.
      const wanted = this.findWanted(npc, people, colliders);
      if (wanted) {
        npc.targetId = wanted.id;
        npc.lastKnown = { x: wanted.x, z: wanted.z };
        npc.seenFor = 0;
        this.setMode(npc, 'hostile', nowMs);
        events.push(this.shout(npc, 'There he is! Stop him!', 'hostile'));
        return;
      }

      const suspect = this.findOffender(npc, people, colliders);
      if (suspect) {
        if (npc.targetId !== suspect.person.id) {
          npc.targetId = suspect.person.id;
          npc.seenFor = 0;
        }
        npc.lastKnown = { x: suspect.person.x, z: suspect.person.z };
        npc.seenFor += dt;
        // Reaction delay: a guard is not a tripwire (CLAUDE.md §20). Past a
        // posted shoot-on-sight line he very nearly is, though — the delay
        // there is a beat to turn, not a beat to think.
        const shootOnSight = suspect.offence.response === 'shoot';
        if (npc.seenFor >= (shootOnSight ? cfg.shootOnSightReaction : cfg.reactionDelay)) {
          if (shootOnSight) {
            // No challenge and no grace. Past that door, or armed in front of
            // the General, the rule is posted and there is nothing to discuss.
            this.setMode(npc, 'hostile', nowMs, cfg.shootOnSightReaction);
          } else {
            this.setMode(npc, 'suspicious', nowMs);
          }
          events.push(this.shout(npc, suspect.offence.text, shootOnSight ? 'hostile' : 'warn'));
          return;
        }
      } else {
        npc.seenFor = Math.max(0, npc.seenFor - dt);
        if (npc.lostSight > cfg.loseSightAfter) npc.targetId = null;

        // Calm guards pick up weapons that players dropped nearby (plan §6).
        // Only in patrol mode (not investigating) so they don't detour mid-search.
        if (npc.mode === 'patrol' && items) {
          this.tickRetrieve(npc, nowMs, dt, colliders, items, events);
        }
      }

      if (npc.mode === 'investigating') this.lookAround(npc, dt, colliders);
      else this.patrol(npc, dt, colliders);
      return;
    }

    // Target dead, or gone from the world entirely.
    if (!current || !current.alive) {
      // Fires exactly once with no flag to track: `standDown` puts him back in
      // `patrol`, and the patrol branch above returns before ever reaching here
      // again. Only announced for a body he can point at — a target that simply
      // vanished from the world is not a kill anybody called.
      if (current && !current.alive) {
        events.push(this.shout(npc, 'Threat neutralised.', 'threat_neutralized'));
      }
      this.standDown(npc);
      this.patrol(npc, dt, colliders);
      return;
    }

    // Lost him. He does not simply forget he was chasing someone: he goes to
    // where the man was last seen and looks. If he had already reached HOSTILE
    // the grudge outlives the search, so the next time that face appears in
    // front of him — this minute or ten minutes later — he opens up again.
    if (npc.lostSight > cfg.loseSightAfter) {
      this.search(npc, npc.lastKnown);
      this.lookAround(npc, dt, colliders);
      return;
    }

    // Chase the man himself while he is in sight, and the last place he was
    // otherwise. A guard must never walk straight at a body he cannot see.
    const goal = visible ?? npc.lastKnown ?? { x: current.x, z: current.z };
    this.faceTarget(npc, goal, dt);

    // Severity is re-judged every tick, not only on first contact. The man
    // being talked to in the corridor who steps through the office door has
    // changed what he is doing, and the warning ladder does not carry across
    // that threshold with him — which is exactly what it used to do, so you
    // could walk in behind a challenge and get two free seconds inside.
    if (offence?.response === 'shoot' && npc.mode !== 'hostile') {
      this.setMode(npc, 'hostile', nowMs, cfg.shootOnSightReaction);
      events.push(this.shout(npc, offence.text, 'hostile'));
      return;
    }

    if (npc.mode === 'suspicious') {
      if (complied && !npc.provoked) {
        this.standDown(npc);
      } else {
        const range = this.approach(npc, goal, dt, colliders, cfg.approachSpeed);
        if (range <= cfg.standoff || npc.modeTimer > 3) {
          this.setMode(npc, 'warning', nowMs);
          events.push(this.shout(npc, offence?.text ?? 'Put the weapon away!', 'warn'));
        }
      }
      return;
    }

    if (npc.mode === 'warning') {
      // A short grace period to comply (CLAUDE.md §19). Putting the weapon away
      // where he can see you do it is enough — this is the one de-escalation.
      if (complied && !npc.provoked) {
        events.push(this.shout(npc, 'Carry on.'));
        this.standDown(npc);
        return;
      }
      this.approach(npc, goal, dt, colliders, cfg.approachSpeed * 0.5);
      if (npc.modeTimer >= cfg.warningDuration) this.setMode(npc, 'hostile', nowMs);
      return;
    }

    // HOSTILE. There is no talking him down now: putting the weapon away is a
    // conversation you should have had before he started shooting.
    const range = this.approach(npc, goal, dt, colliders, cfg.approachSpeed);
    if (!npc.unarmed && visible && range <= WEAPONS[GUARD_WEAPON].range && nowMs >= npc.nextShotAt) {
      npc.nextShotAt = nowMs + cfg.fireInterval * 1000;
      this.shoot(npc, people, colliders, events);
    }
  }

  /**
   * The General (CLAUDE.md §25, §26). He has no weapon and he never gets one —
   * the assassination is supposed to be about access and angle, not a boss
   * fight. What he has is a room with two pillars and two cabinets in it, and
   * the sense to keep one of them between himself and whoever is shooting.
   *
   * Modes are the guard's, reused rather than duplicated: `patrol` is standing
   * at his desk, `investigating` is moving to cover, `hostile` is bolting.
   */
  private tickGeneral(
    npc: Npc,
    dt: number,
    people: readonly Perceivable[],
    colliders: readonly Collider[],
  ): void {
    npc.modeTimer += dt;

    if (npc.mode === 'patrol') {
      // A single-entry route, so this walks him back to the desk and turns him
      // to face the door again. Check for armed intruders before leaving.
      this.patrol(npc, dt, colliders);

      // Scan for the nearest person with a visible weapon who is inside the
      // office AND in LOS. A rifle glimpsed through the corridor door is not his
      // concern — the guards between him and the door handle that.
      let armed: Perceivable | null = null;
      let armedDist = Infinity;
      for (const p of people) {
        if (!p.alive || p.weapon === null) continue;
        // Only react to armed people inside his restricted office zone.
        if (restrictedZoneAt(p.x, p.z)?.response !== 'shoot') continue;
        const dx = p.x - npc.body.position.x;
        const dz = p.z - npc.body.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= armedDist) continue;
        if (!this.canSee(npc, p, colliders)) continue;
        armed = p;
        armedDist = dist;
      }

      if (armed) {
        // Brief confirmation delay (reusing reactionDelay) so a barrel clearing
        // the doorway doesn't teleport him into cover instantly.
        npc.seenFor += dt;
        if (npc.seenFor >= cfg.reactionDelay) {
          npc.seenFor = 0;
          this.alarmGeneral(npc, armed.id, { x: armed.x, z: armed.z });
        }
      } else {
        npc.seenFor = 0;
      }
      return;
    }

    const threat =
      npc.targetId != null ? people.find((p) => p.id === npc.targetId && p.alive) : undefined;
    if (threat && this.canSee(npc, threat, colliders)) {
      npc.lastKnown = { x: threat.x, z: threat.z };
      npc.lostSight = 0;
    } else {
      npc.lostSight += dt;
    }

    // He has no way of knowing when it is over, so he gives it long enough to
    // be fairly sure and then goes back to work.
    if (npc.lostSight >= gen.calmAfter) {
      this.standDown(npc);
      return;
    }

    // Never saw who it was? Then it came through the door, because there is no
    // other way in — which is also the direction he most wants a wall.
    const from = npc.lastKnown ?? HQ_DOOR;

    if (npc.mode === 'investigating') {
      npc.coverTimer -= dt;
      if (!npc.cover || npc.coverTimer <= 0) {
        npc.coverTimer = gen.coverRefresh;
        // Re-picked as the man moves, so circling the pillar makes him shuffle
        // round it instead of standing in a spot that stopped working.
        npc.cover = this.pickCover(npc, from, colliders);
      }

      // Cornered: every piece of cover in the room is in the open from where
      // that man is standing, he has been hit twice already, or — the one that
      // matters most — the man is INSIDE the office. Shuffling round a pillar
      // works on a shooter out in the corridor; with him through the door it is
      // just standing still while he walks round it, which is what playtesting
      // found. Requires a localised threat: `from` falls back to HQ_DOOR, which
      // sits exactly on the room's boundary, so without this he would bolt at
      // any noise he never placed.
      const threatInRoom =
        npc.lastKnown != null &&
        restrictedZoneAt(npc.lastKnown.x, npc.lastKnown.z)?.response === 'shoot';

      if (!npc.cover || threatInRoom || npc.hitsTaken >= gen.hitsBeforeBolting) {
        npc.mode = 'hostile';
        npc.modeTimer = 0;
        npc.cover = this.boltFor(npc, from);
        this.dropRoute(npc);
        return;
      }

      // In position: stop and watch the way he came. Facing the man costs him
      // nothing — cover is decided by the line from the THREAT's eye to his
      // chest, and turning his head does not move either end of it — but it
      // does point his own vision cone at the door, so he keeps track of
      // someone leaning out rather than staring at a pillar.
      const toCover = Math.hypot(
        npc.cover.x - npc.body.position.x,
        npc.cover.z - npc.body.position.z,
      );
      if (toCover <= cfg.pathWaypointReach) {
        this.faceTarget(npc, from, dt);
        this.step(npc, 0, 0, 0, dt, colliders);
        return;
      }

      this.navigate(npc, npc.cover, dt, colliders, gen.fleeSpeed, true);
      return;
    }

    // HOSTILE, which for him means running — toward guards rather than into an
    // empty corridor, and stopping when he reaches them rather than running the
    // compound in circles.
    const dest = npc.cover ?? HQ_DOOR;
    const left = Math.hypot(dest.x - npc.body.position.x, dest.z - npc.body.position.z);
    if (left <= cfg.waypointReach) {
      this.faceTarget(npc, from, dt);
      this.step(npc, 0, 0, 0, dt, colliders);
      return;
    }
    this.navigate(npc, dest, dt, colliders, gen.fleeSpeed, true);
  }

  /**
   * Something happened to him, or in his office, or near enough to it. Only
   * promotes him out of `patrol`: an alarm arriving while he is already moving
   * refreshes what he knows without restarting the decision.
   */
  private alarmGeneral(npc: Npc, threatId: number | null, at: NavPoint | null): void {
    if (!npc.alive || npc.kind !== 'general') return;
    if (threatId != null) npc.targetId = threatId;
    if (at) npc.lastKnown = { x: at.x, z: at.z };
    npc.lostSight = 0;
    if (npc.mode !== 'patrol') return;

    npc.mode = 'investigating';
    npc.modeTimer = 0;
    npc.cover = null;
    npc.coverTimer = 0;
    npc.path = null;
    npc.pathGoal = null;
    npc.repathIn = 0;
  }

  /**
   * The nearest cover the threat cannot see, nudged toward the far side of the
   * room. Nearest matters because he is being shot at now; the nudge is because
   * ducking behind the pillar the gunman is standing beside is not hiding.
   * Null means there is nowhere left, which is the signal to run.
   */
  private pickCover(
    npc: Npc,
    threat: NavPoint,
    colliders: readonly Collider[],
  ): NavPoint | null {
    const here = { x: npc.body.position.x, z: npc.body.position.z };
    let best: NavPoint | null = null;
    let bestScore = Infinity;

    for (const spot of coverSpots()) {
      if (!this.hiddenFrom(spot, threat, colliders)) continue;
      const route = findPath(here, spot);
      if (!route) continue;
      const score =
        pathLength(here, route) - Math.hypot(spot.x - threat.x, spot.z - threat.z) * 0.35;
      if (score >= bestScore) continue;
      bestScore = score;
      best = spot;
    }
    return best;
  }

  /**
   * Would a man standing at `spot` be out of sight from `threat`? Same eye and
   * chest heights `canSee` uses, so hiding from the player's own line of sight
   * is the same test the guards are judged by — hiding LOOKS like hiding.
   */
  private hiddenFrom(
    spot: NavPoint,
    threat: NavPoint,
    colliders: readonly Collider[],
  ): boolean {
    const eye: Vec3 = { x: threat.x, y: EYE, z: threat.z };
    const dx = spot.x - eye.x;
    const dy = CHEST - eye.y;
    const dz = spot.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return false;
    const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
    return raycastColliders(eye, dir, len, colliders) !== null;
  }

  /** Where to run: a guard post out of the office, away from him, close to me. */
  private boltFor(npc: Npc, threat: NavPoint): NavPoint {
    const here = { x: npc.body.position.x, z: npc.body.position.z };
    let best: NavPoint = HQ_DOOR;
    let bestScore = -Infinity;

    for (const post of GUARD_POSTS) {
      for (const wp of post.route) {
        // Out of the office. Sprinting to the sentry standing six feet from his
        // own desk is not an escape from anything.
        if (restrictedZoneAt(wp.x, wp.z)?.response === 'shoot') continue;
        const away = Math.hypot(wp.x - threat.x, wp.z - threat.z);
        const near = Math.hypot(wp.x - here.x, wp.z - here.z);
        const score = away - near * 0.6;
        if (score <= bestScore) continue;
        bestScore = score;
        best = { x: wp.x, z: wp.z };
      }
    }
    return best;
  }

  /**
   * `cue` is omitted where there is a line to read but nothing worth hearing —
   * "Carry on." is a de-escalation, and there is no recording of it.
   */
  private shout(npc: Npc, text: string, cue?: GuardVoiceCue): NpcEvent {
    return { t: 'shout', id: npc.id, text, x: npc.body.position.x, z: npc.body.position.z, cue };
  }

  private setMode(
    npc: Npc,
    mode: GuardMode,
    nowMs: number,
    firstShotDelay: number = cfg.reactionDelay,
  ): void {
    npc.mode = mode;
    npc.modeTimer = 0;
    // Abandon any item-retrieval goal when going alert.
    if (mode !== 'patrol') npc.retrieve = null;
    this.dropRoute(npc);
    if (mode === 'hostile') {
      // One more reaction delay before the first shot: the instant the guard
      // gives up on you there still has to be a beat in which you can run.
      // Shorter past a posted line, where the whole point is that there isn't.
      npc.nextShotAt = nowMs + firstShotDelay * 1000;
      // And this is the moment it becomes personal. Everything past here is
      // about the man, not about what he happens to be holding.
      npc.provoked = true;
      if (npc.targetId != null) npc.grudges.add(npc.targetId);
      // His own detail opening fire inside the office is all the warning he is
      // going to get, and he does not have to see the man to take it.
      if (restrictedZoneAt(npc.body.position.x, npc.body.position.z)?.response === 'shoot') {
        const general = this.npcs.find((n) => n.kind === 'general' && n.alive);
        if (general) this.alarmGeneral(general, npc.targetId, npc.lastKnown);
      }
    }
  }

  /** Give up on the current target and go back to the route. Grudges survive. */
  private standDown(npc: Npc): void {
    npc.mode = 'patrol';
    npc.modeTimer = 0;
    npc.targetId = null;
    npc.seenFor = 0;
    npc.provoked = false;
    npc.investigate = null;
    npc.investigateTimer = 0;
    npc.cover = null;
    this.resumeRoute(npc);
  }

  /** Switch to walking over to look at a spot. A null spot means give up. */
  private search(npc: Npc, spot: { x: number; z: number } | null): void {
    if (!spot) {
      this.standDown(npc);
      return;
    }
    npc.targetId = null;
    npc.seenFor = 0;
    npc.provoked = false;
    this.beginInvestigation(npc, spot);
  }

  /**
   * Set a guard walking to a spot, and work out how long he will give it.
   *
   * The deadline is the length of the route he actually has to walk plus time
   * to look round when he gets there. A flat eleven seconds meant a shot in
   * Storage was abandoned in the cross corridor: he set off, then turned back
   * for no reason a watching player could possibly infer.
   */
  private beginInvestigation(npc: Npc, at: NavPoint): void {
    const from = { x: npc.body.position.x, z: npc.body.position.z };
    npc.investigate = { x: at.x, z: at.z };
    npc.investigateTimer = 0;
    npc.mode = 'investigating';
    npc.modeTimer = 0;
    this.dropRoute(npc);

    // The direction he sets off in, which is also the direction he goes on
    // looking once he arrives — a man who came to find out what a noise was
    // faces past it, not back the way he came.
    const bearing = Math.hypot(at.x - from.x, at.z - from.z);
    npc.investigateBearing = bearing > 1e-3 ? yawTowards(at.x - from.x, at.z - from.z) : npc.yaw;

    const route = findPath(from, at);
    const distance = route
      ? pathLength(from, route)
      : Math.hypot(at.x - from.x, at.z - from.z);
    npc.investigateDeadline = Math.max(
      cfg.investigateTimeout,
      distance / cfg.approachSpeed + cfg.investigateLinger + cfg.investigateSlack,
    );
  }

  /**
   * Rejoin the patrol loop at the nearest point rather than at whatever
   * waypoint was next when the chase started — otherwise a guard who ran the
   * length of the compound walks all the way back to resume where he left off.
   */
  private resumeRoute(npc: Npc): void {
    this.dropRoute(npc);
    if (npc.route.length <= 1) return;

    const here = { x: npc.body.position.x, z: npc.body.position.z };
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < npc.route.length; i++) {
      const wp = npc.route[i];
      const route = findPath(here, wp);
      // WALKING distance, not straight-line. Standing in a side room the nearest
      // waypoint as the crow flies is regularly the one on the other side of the
      // wall he is facing, and heading for it meant heading into the wall.
      // Unreachable waypoints are ranked behind every reachable one rather than
      // dropped, so a guard boxed in by a closed route still has somewhere to go.
      const score = route
        ? pathLength(here, route)
        : Math.hypot(wp.x - here.x, wp.z - here.z) + 1e4;
      if (score >= bestScore) continue;
      bestScore = score;
      best = i;
    }
    npc.waypoint = best;
  }

  /**
   * Nearest visible person this guard has already been pushed all the way to
   * hostility by. Being unarmed and well-behaved does not help you here.
   */
  private findWanted(
    npc: Npc,
    people: readonly Perceivable[],
    colliders: readonly Collider[],
  ): Perceivable | null {
    if (npc.grudges.size === 0) return null;
    let best: Perceivable | null = null;
    let bestDistance = Infinity;
    for (const p of people) {
      if (!p.alive || !npc.grudges.has(p.id)) continue;
      const d = Math.hypot(p.x - npc.body.position.x, p.z - npc.body.position.z);
      if (d >= bestDistance) continue;
      if (!this.canSee(npc, p, colliders)) continue;
      best = p;
      bestDistance = d;
    }
    return best;
  }

  /** Nearest visible person doing something a guard is posted to stop. */
  private findOffender(
    npc: Npc,
    people: readonly Perceivable[],
    colliders: readonly Collider[],
  ): { person: Perceivable; offence: Offence } | null {
    let best: { person: Perceivable; offence: Offence } | null = null;
    let bestDistance = Infinity;
    for (const p of people) {
      const offence = offenceOf(p);
      if (!offence) continue;
      const d = Math.hypot(p.x - npc.body.position.x, p.z - npc.body.position.z);
      if (d >= bestDistance) continue;
      if (!this.canSee(npc, p, colliders)) continue;
      best = { person: p, offence };
      bestDistance = d;
    }
    return best;
  }

  /**
   * Walk to the spot he is curious about and look around it: a noise he heard,
   * or the last place he saw someone he was chasing. Gives up after
   * `investigateLinger` seconds on station, or `investigateTimeout` in total if
   * the spot turns out to be unreachable.
   */
  private lookAround(npc: Npc, dt: number, colliders: readonly Collider[]): void {
    const spot = npc.investigate;
    if (!spot) {
      this.standDown(npc);
      this.patrol(npc, dt, colliders);
      return;
    }

    const dx = spot.x - npc.body.position.x;
    const dz = spot.z - npc.body.position.z;
    const d = Math.hypot(dx, dz);
    if (d > cfg.investigateReach) {
      npc.investigateTimer = 0;
      // Walk at his OWN spot beside the noise rather than at the noise itself,
      // so three responders converging on one shot approach on three headings
      // instead of stacking up in the doorway. Arrival is still measured against
      // the noise: a man already standing on it has arrived.
      this.navigate(npc, spreadSpot(npc, spot), dt, colliders, cfg.approachSpeed, true);
    } else {
      npc.investigateTimer += dt;
      // Sweep the cone ACROSS the bearing he came in on instead of spinning on
      // the spot from whatever yaw he happened to arrive with. Spinning meant he
      // spent most of the linger facing away from the thing he came to look at.
      const sweep =
        Math.sin(npc.investigateTimer * cfg.investigateSweepRate) * cfg.investigateSweepArc;
      this.turnTowards(npc, wrapAngle(npc.investigateBearing + sweep), dt);
      this.step(npc, 0, 0, 0, dt, colliders);
    }

    if (npc.investigateTimer >= cfg.investigateLinger || npc.modeTimer >= npc.investigateDeadline) {
      this.standDown(npc);
    }
  }

  /**
   * Handle the guard's retrieve goal: walk to a dropped item and confiscate it
   * (plan §6). Only called while the guard is calm (patrol mode, no threat).
   */
  private tickRetrieve(
    npc: Npc,
    nowMs: number,
    dt: number,
    colliders: readonly Collider[],
    items: ItemField,
    events: NpcEvent[],
  ): void {
    const pos = npc.body.position;

    // Check if the current goal is still valid.
    if (npc.retrieve) {
      const goal = npc.retrieve;
      // Item disappeared (player beat him to it), deadline passed, or mode changed.
      if (!items.get(goal.itemId) || nowMs > goal.until) {
        npc.retrieve = null;
        this.dropRoute(npc);
        return;
      }
      // Navigate to the item (reusing patrol speed so he doesn't rush).
      // tickRetrieve is called after seenFor/patrol logic which already consumed dt,
      // so we forward the same dt we were given.
      this.navigate(npc, goal, dt, colliders, cfg.patrolSpeed, true);
      // Check arrival.
      if (Math.hypot(pos.x - goal.x, pos.z - goal.z) <= GAME_CONFIG.items.reach) {
        const item = items.remove(goal.itemId);
        if (item) {
          if (isWeaponItem(item.item)) npc.carried.push(item.item);
          events.push({ t: 'took', id: npc.id, itemId: item.id });
        }
        npc.retrieve = null;
        this.dropRoute(npc);
        this.resumeRoute(npc);
      }
      return;
    }

    // Scan for the nearest visible dropped item.
    const eye: Vec3 = { x: pos.x, y: pos.y + EYE, z: pos.z };
    let best: GroundItem | null = null;
    let bestDist: number = cfg.itemSightRadius;
    for (const item of items.list()) {
      if (!item.dropped || !isWeaponItem(item.item)) continue;
      const dist = Math.hypot(item.x - pos.x, item.z - pos.z);
      if (dist > bestDist) continue;
      // View cone check.
      const dx = item.x - pos.x;
      const dz = item.z - pos.z;
      const flat = Math.hypot(dx, dz);
      if (flat > 1e-3) {
        const facingX = -Math.sin(npc.yaw);
        const facingZ = -Math.cos(npc.yaw);
        const cos = (dx / flat) * facingX + (dz / flat) * facingZ;
        if (cos < Math.cos(cfg.viewAngle)) continue;
      }
      // Line of sight to the item on the floor.
      const tdx = item.x - eye.x;
      const tdy = item.y - eye.y;
      const tdz = item.z - eye.z;
      const len = Math.hypot(tdx, tdy, tdz);
      if (len < 1e-3) { best = item; bestDist = dist; continue; }
      const dir: Vec3 = { x: tdx / len, y: tdy / len, z: tdz / len };
      if (raycastColliders(eye, dir, len, colliders)) continue;
      best = item;
      bestDist = dist;
    }
    if (!best) return;

    npc.retrieve = {
      itemId: best.id,
      x: best.x,
      z: best.z,
      until: nowMs + cfg.itemRetrieveDeadline * 1000,
    };
  }

  /**
   * Vision cone plus line of sight (CLAUDE.md §21). The raycast is against the
   * same colliders the client renders, so a wall really is a wall — this is the
   * check that makes hiding behind one work.
   */
  canSee(npc: Npc, p: Perceivable, colliders: readonly Collider[]): boolean {
    const eye: Vec3 = { x: npc.body.position.x, y: npc.body.position.y + EYE, z: npc.body.position.z };
    const dx = p.x - eye.x;
    const dz = p.z - eye.z;
    const flat = Math.hypot(dx, dz);
    if (flat > cfg.viewDistance) return false;
    if (flat > 1e-3) {
      const facingX = -Math.sin(npc.yaw);
      const facingZ = -Math.cos(npc.yaw);
      const cos = (dx / flat) * facingX + (dz / flat) * facingZ;
      if (cos < Math.cos(cfg.viewAngle)) return false;
    }
    const dy = p.y + CHEST - eye.y;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
    return !raycastColliders(eye, dir, len, colliders);
  }

  private faceTarget(npc: Npc, p: { x: number; z: number }, dt: number): void {
    this.turnTowards(npc, yawTowards(p.x - npc.body.position.x, p.z - npc.body.position.z), dt);
  }

  private turnTowards(npc: Npc, desired: number, dt: number): void {
    const delta = wrapAngle(desired - npc.yaw);
    const step = TURN_RATE * dt;
    npc.yaw = wrapAngle(npc.yaw + Math.max(-step, Math.min(step, delta)));
  }

  /**
   * Close on the target, stopping at standoff range. Returns current range.
   *
   * Range is the straight line, because that is what shooting cares about; the
   * WALKING is done on the navgrid. The two differ at exactly the moment it
   * matters — five metres away through a wall is not five metres away, and a
   * guard who stopped there used to stand grinding against the brickwork.
   */
  private approach(
    npc: Npc,
    p: { x: number; z: number },
    dt: number,
    colliders: readonly Collider[],
    speed: number,
  ): number {
    const here = { x: npc.body.position.x, z: npc.body.position.z };
    const range = Math.hypot(p.x - here.x, p.z - here.z);
    if (range > cfg.standoff || !clearLine(here, p)) {
      // No turning: the caller has already faced him at the man, and a guard
      // sidestepping round a corner with his rifle still up is the point.
      this.navigate(npc, p, dt, colliders, speed, false);
    } else {
      this.step(npc, 0, 0, 0, dt, colliders);
    }
    return range;
  }

  /**
   * One step along the shortest walkable route to `goal` (CLAUDE.md §21 — the
   * map is supposed to matter, and it cannot matter to someone who cannot find
   * a door). Falls back to the straight line if there is no route at all, so a
   * pathfinding gap makes an NPC clumsy rather than catatonic.
   */
  private navigate(
    npc: Npc,
    goal: NavPoint,
    dt: number,
    colliders: readonly Collider[],
    speed: number,
    turn: boolean,
  ): void {
    const here = { x: npc.body.position.x, z: npc.body.position.z };

    npc.repathIn -= dt;
    const drift = npc.pathGoal
      ? Math.hypot(goal.x - npc.pathGoal.x, goal.z - npc.pathGoal.z)
      : Infinity;
    if (npc.repathIn <= 0 || drift > cfg.repathGoalDrift) {
      npc.repathIn = cfg.repathInterval;
      npc.pathGoal = { x: goal.x, z: goal.z };
      npc.path = findPath(here, goal);
    }

    // Drop waypoints already reached. The last one is the goal itself, so it is
    // never dropped — arriving is the caller's business, not the route's.
    let popped = false;
    while (npc.path && npc.path.length > 1) {
      const wp = npc.path[0];
      if (Math.hypot(wp.x - here.x, wp.z - here.z) > cfg.pathWaypointReach) break;
      npc.path.shift();
      popped = true;
    }

    // Waypoints are only clear FROM each other. Having left one early, the leg
    // to the next may now cross a wall, so check it and re-route rather than
    // walking it — this is the doorway jam, and it looks identical to the
    // wall-bumping the routing was supposed to end.
    if (popped && npc.path && npc.path.length > 0 && !clearLine(here, npc.path[0])) {
      npc.path = findPath(here, goal);
      npc.repathIn = cfg.repathInterval;
    }

    const step = npc.path && npc.path.length > 0 ? npc.path[0] : goal;
    const dx = step.x - here.x;
    const dz = step.z - here.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) {
      this.step(npc, 0, 0, 0, dt, colliders);
      return;
    }
    if (turn) this.turnTowards(npc, yawTowards(dx, dz), dt);
    this.step(npc, dx / d, dz / d, speed, dt, colliders);
  }

  /**
   * Walk the route (CLAUDE.md §19). On the navgrid, like everything else that
   * moves: this used to drive straight at the next waypoint, which is fine in a
   * corridor and catastrophic anywhere else. A guard who finished investigating
   * inside a one-door room stood down, picked the waypoint on the far side of
   * the wall he was facing, walked into that wall, and never got close enough
   * to advance — so he ground there, in a room, forever.
   */
  private patrol(npc: Npc, dt: number, colliders: readonly Collider[]): void {
    if (npc.route.length <= 1) {
      // Static post: walk back to it, then face the way we are meant to face.
      const home = npc.route[0];
      const dx = home.x - npc.body.position.x;
      const dz = home.z - npc.body.position.z;
      if (Math.hypot(dx, dz) > cfg.waypointReach) {
        this.navigate(npc, home, dt, colliders, cfg.patrolSpeed, true);
        return;
      }
      this.faceFromPost(npc, dt);
      this.step(npc, 0, 0, 0, dt, colliders);
      return;
    }

    const wp = npc.route[npc.waypoint];
    const d = Math.hypot(wp.x - npc.body.position.x, wp.z - npc.body.position.z);
    if (d <= cfg.waypointReach) {
      npc.waypoint = (npc.waypoint + 1) % npc.route.length;
      this.dropRoute(npc);
      return;
    }
    this.navigate(npc, wp, dt, colliders, cfg.patrolSpeed, true);
  }

  /**
   * Where a man standing on his post looks: at the noise he just heard, if there
   * was one and it was recent, otherwise the way the post faces. He never leaves
   * — turning IS the response — but a 162° cone swung round is enough to notice
   * someone behind him with a rifle, and `findOffender` runs every tick.
   */
  private faceFromPost(npc: Npc, dt: number): void {
    const look = npc.alertLookTimer > 0 ? npc.alertLook : null;
    if (!look) {
      npc.alertLook = null;
      this.turnTowards(npc, npc.postYaw, dt);
      return;
    }
    const dx = look.x - npc.body.position.x;
    const dz = look.z - npc.body.position.z;
    // A noise at his own feet gives no bearing at all; keep looking where he is.
    if (Math.hypot(dx, dz) < 0.5) return;
    this.turnTowards(npc, yawTowards(dx, dz), dt);
  }

  /** Throw away the cached route so the next `navigate` builds a fresh one. */
  private dropRoute(npc: Npc): void {
    npc.path = null;
    npc.pathGoal = null;
    npc.repathIn = 0;
    npc.stuckFor = 0;
    npc.stuckRepathIn = 0;
  }

  /**
   * One movement integration step, using the same collision code as players,
   * plus the only thing watching for an NPC who has stopped working.
   *
   * Nothing used to notice. A guard wedged against a wall, or two of them stood
   * in the same doorway, simply pushed at it for the rest of the round, and
   * every symptom a player could see — the staring, the sweeping at nothing —
   * was downstream of that.
   */
  private step(
    npc: Npc,
    dirX: number,
    dirZ: number,
    speed: number,
    dt: number,
    colliders: readonly Collider[],
  ): void {
    const fromX = npc.body.position.x;
    const fromZ = npc.body.position.z;

    npc.body.velocity.x = dirX * speed;
    npc.body.velocity.z = dirZ * speed;
    npc.body.velocity.y -= GAME_CONFIG.movement.gravity * dt;
    // Once he has been grinding for `stuckRepathAfter`, other BODIES stop
    // blocking him — walls never do. Nothing here steers around a crowd, and a
    // crowd is what he is usually stuck in: the General bolting for the door
    // was reliably pinned in place by his own detail closing on the man chasing
    // him, four guards pressed against him and no way through any of them. Two
    // NPCs briefly overlapping is a cosmetic problem; a General welded to the
    // floor by his bodyguards is not. Real movement clears it on the same tick.
    const jammed = npc.stuckFor >= cfg.stuckRepathAfter;
    moveBody(npc.body, dt, colliders, jammed ? [] : this.otherActors(npc));
    if (npc.body.grounded) npc.body.velocity.y = 0;

    // Standing still on purpose is not being stuck.
    if (speed <= 0 || dt <= 0) {
      npc.stuckFor = 0;
      return;
    }
    const moved = Math.hypot(npc.body.position.x - fromX, npc.body.position.z - fromZ);
    if (moved >= speed * dt * 0.35) {
      // Winds down rather than resetting, so squeezing out of a scrum is one
      // continuous movement. A hard reset re-solidified everyone around him the
      // instant he twitched, and he left the room a centimetre at a time.
      npc.stuckFor = Math.max(0, npc.stuckFor - dt * 2);
      npc.stuckRepathIn = 0;
      return;
    }

    npc.stuckFor += dt;
    npc.stuckRepathIn -= dt;
    if (npc.stuckFor >= cfg.stuckGiveUpAfter) {
      this.abandonGoal(npc);
      return;
    }
    if (npc.stuckFor >= cfg.stuckRepathAfter && npc.stuckRepathIn <= 0) {
      // Re-route from where he actually is. Rate-limited to the normal repath
      // interval so a jammed guard does not run A* every frame.
      npc.path = null;
      npc.pathGoal = null;
      npc.repathIn = 0;
      npc.stuckRepathIn = cfg.repathInterval;
    }
  }

  /**
   * Grinding for `stuckGiveUpAfter` seconds means the goal is not reachable
   * from here, whatever the grid thinks. Drop it and do the next thing rather
   * than keep pushing: a guard who gives up on one waypoint and walks to the
   * next one reads as a man losing interest, which is fine. A guard pressed
   * into a wall reads as a broken game.
   */
  private abandonGoal(npc: Npc): void {
    this.dropRoute(npc);
    if (npc.kind === 'general') {
      // Only while hiding: `cover` doubles as the bolt destination once he is
      // running, and dropping that would strand him at the door he set off from.
      if (npc.mode === 'investigating') {
        npc.cover = null;
        npc.coverTimer = 0;
      }
      return;
    }
    if (npc.mode === 'investigating') {
      this.standDown(npc);
      return;
    }
    if (npc.mode === 'patrol' && npc.route.length > 1) {
      npc.waypoint = (npc.waypoint + 1) % npc.route.length;
    }
  }

  private otherActors(self: Npc): Actor[] {
    const out: Actor[] = [];
    for (const n of this.npcs) {
      if (n === self || !n.alive) continue;
      out.push({
        x: n.body.position.x,
        y: n.body.position.y,
        z: n.body.position.z,
        radius: n.body.radius,
        height: n.body.height,
      });
    }
    return out;
  }

  /**
   * One rifle shot. Modest accuracy and a slow fire rate, deliberately: a guard
   * has to be escapable or the compound is unplayable (CLAUDE.md §20).
   *
   * Guard bullets resolve against players and walls only — a guard will not
   * accidentally shoot another guard, which would cascade into a firefight
   * nobody started.
   */
  private shoot(
    npc: Npc,
    people: readonly Perceivable[],
    colliders: readonly Collider[],
    events: NpcEvent[],
  ): void {
    const target = people.find((p) => p.id === npc.targetId);
    if (!target) return;

    const origin: Vec3 = {
      x: npc.body.position.x,
      y: npc.body.position.y + EYE,
      z: npc.body.position.z,
    };
    const dx = target.x - origin.x;
    const dy = target.y + CHEST - origin.y;
    const dz = target.z - origin.z;
    const len = Math.hypot(dx, dy, dz) || 1;

    // Accuracy → cone half-angle. 1.0 would be a laser; 0.7 misses often enough.
    const spread = (1 - cfg.accuracy) * 0.14;
    const yawJitter = (Math.random() * 2 - 1) * spread;
    const pitchJitter = (Math.random() * 2 - 1) * spread;
    let dirX = dx / len + -dz / len * yawJitter;
    let dirZ = dz / len + dx / len * yawJitter;
    let dirY = dy / len + pitchJitter;
    const norm = Math.hypot(dirX, dirY, dirZ) || 1;
    dirX /= norm;
    dirY /= norm;
    dirZ /= norm;

    const targets: CombatTarget[] = people.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      alive: p.alive,
    }));
    const outcome = resolveShot(
      origin,
      { x: dirX, y: dirY, z: dirZ },
      GUARD_WEAPON,
      targets,
      colliders,
      npc.id,
    );

    events.push({ t: 'shot', id: npc.id, weapon: GUARD_WEAPON, origin, end: outcome.point });
    if (outcome.kind === 'hit') {
      events.push({
        t: 'hit',
        id: npc.id,
        targetId: outcome.targetId,
        region: outcome.region,
        damage: WEAPONS[GUARD_WEAPON].damage[HIT_CLASS[outcome.region]],
      });
    }
  }
}

/**
 * Something a guard is posted to stop, and what he does about it.
 *
 * `warn` is the CLAUDE.md §19 ladder: challenge, two seconds of grace, then
 * shoot. `shoot` skips the conversation — it exists only for the General's
 * office, where the rule is posted and everyone knows it.
 */
export type Offence = {
  kind: 'weapon' | 'trespass' | 'armed_in_zone';
  response: ZoneResponse;
  /** What the guard shouts. Nearby humans read it as proximity chat. */
  text: string;
};

/**
 * The whole of a guard's judgement (CLAUDE.md §18). Note what is NOT here: no
 * suspicion score, no memory, no inference about who someone might be. Two
 * posted rules, and they are the same two rules for everybody.
 */
export function offenceOf(p: Perceivable): Offence | null {
  if (!p.alive) return null;

  const zone = restrictedZoneAt(p.x, p.z);
  if (zone) {
    // A weapon in the General's office is hostile whoever is holding it —
    // including the Security Officer, who may carry a rifle anywhere else.
    if (zone.noWeapons && p.weapon !== null) {
      return { kind: 'armed_in_zone', response: 'shoot', text: 'Weapon! Put him down!' };
    }
    // `hqAccess` is the secretary's revoked pass. Checked here rather than in a
    // parallel rule so that a banned secretary is challenged by exactly the
    // machinery that challenges a doctor at the same door.
    if (!zone.allow.includes(p.role) || p.hqAccess === false) {
      return {
        kind: 'trespass',
        response: zone.response,
        text:
          zone.response === 'shoot'
            ? 'Intruder in the office!'
            : 'Away from that door! No entry!',
      };
    }
  }

  // The original rule: visibly holding something your public occupation has no
  // business holding. `canBrandish` is the single authorisation function.
  if (p.weapon !== null && !canBrandish(p.role, p.weapon)) {
    return { kind: 'weapon', response: 'warn', text: 'Put the weapon away!' };
  }

  return null;
}

/** Convenience wrapper: is this person doing anything at all wrong? */
export function isOffence(p: Perceivable): boolean {
  return offenceOf(p) !== null;
}
