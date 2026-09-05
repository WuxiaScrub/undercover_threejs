/**
 * THE single source of truth for the compound (CLAUDE.md §27/§28).
 *
 * The client builds meshes from this and the server (milestone 2+) builds its
 * line-of-sight / shot-occlusion geometry from the exact same data, so the two
 * can never disagree about where a wall is.
 *
 * Coordinate convention: +X is east, +Z is SOUTH, so north is -Z.
 *
 *                          NORTH  (-Z)
 *   x=-20      x=-14                 x=14      x=20
 *     +----------+---------------------+----------+   z=-22
 *     |          |     GENERAL HQ      |          |
 *     |   WEST   |    (General + guards)|   EAST   |   z=-12
 *     |          |  ADMIN | : | WAITING |          |
 *     | CORRIDOR |--------+ : +---------| CORRIDOR |   z=-2
 *     |          |     CROSS CORRIDOR   |          |   z=+2
 *     |          | TELEGRAM| : | MEDICAL|          |
 *     |          |---------+ : +--------|          |   z=+12
 *     |          |     CENTRAL HALL     |          |
 *     |          |----------------------|          |   z=+22
 *     |          | SECURITY | STORAGE   |          |
 *     +----------+---------------------+----------+   z=+30
 *                          SOUTH  (+Z)
 */
import { GAME_CONFIG } from './constants';
import type { Role } from './roles';
import type { Collider, CompoundMap, Room, RoomId, Vec3 } from './types';

const { wallHeight, wallThickness, doorWidth } = GAME_CONFIG.world;

const COLOR = {
  wall: 0x8a8574,
  innerWall: 0x9a9483,
  floorCorridor: 0x4a4d47,
  floorRoom: 0x565a52,
  floorHq: 0x5c5344,
  floorHall: 0x4f5349,
  desk: 0x6b4f35,
  cabinet: 0x55483a,
  crate: 0x7a6242,
  bed: 0xa8b0ab,
  pillar: 0x6f6a5c,
  rack: 0x4d4438,
} as const;

type Gap = { at: number; width?: number };

const t = wallThickness / 2;

/** Wall running east-west at a fixed z, from x0 to x1, with doorway gaps. */
function wallAlongX(z: number, x0: number, x1: number, gaps: Gap[] = [], label?: string): Collider[] {
  const out: Collider[] = [];
  const sorted = [...gaps].sort((a, b) => a.at - b.at);
  let cursor = x0;
  for (const gap of sorted) {
    const w = gap.width ?? doorWidth;
    const start = gap.at - w / 2;
    const end = gap.at + w / 2;
    if (start > cursor) out.push(box(cursor, -t + z, start, t + z, label));
    cursor = Math.max(cursor, end);
  }
  if (x1 > cursor) out.push(box(cursor, -t + z, x1, t + z, label));
  return out;

  function box(minX: number, minZ: number, maxX: number, maxZ: number, l?: string): Collider {
    return {
      min: { x: minX, y: 0, z: minZ },
      max: { x: maxX, y: wallHeight, z: maxZ },
      kind: 'wall',
      color: COLOR.wall,
      label: l,
    };
  }
}

/** Wall running north-south at a fixed x, from z0 to z1, with doorway gaps. */
function wallAlongZ(x: number, z0: number, z1: number, gaps: Gap[] = [], label?: string): Collider[] {
  const out: Collider[] = [];
  const sorted = [...gaps].sort((a, b) => a.at - b.at);
  let cursor = z0;
  for (const gap of sorted) {
    const w = gap.width ?? doorWidth;
    const start = gap.at - w / 2;
    const end = gap.at + w / 2;
    if (start > cursor) out.push(seg(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (z1 > cursor) out.push(seg(cursor, z1));
  return out;

  function seg(minZ: number, maxZ: number): Collider {
    return {
      min: { x: x - t, y: 0, z: minZ },
      max: { x: x + t, y: wallHeight, z: maxZ },
      kind: 'wall',
      color: COLOR.wall,
      label,
    };
  }
}

/** A prop, positioned by its footprint centre with its base on the floor. */
function prop(
  cx: number,
  cz: number,
  sizeX: number,
  height: number,
  sizeZ: number,
  color: number,
  label: string,
  baseY = 0,
): Collider {
  return {
    min: { x: cx - sizeX / 2, y: baseY, z: cz - sizeZ / 2 },
    max: { x: cx + sizeX / 2, y: baseY + height, z: cz + sizeZ / 2 },
    kind: 'prop',
    color,
    label,
  };
}

const BOUNDS = { minX: -20, maxX: 20, minZ: -22, maxZ: 30 };

const rooms: Room[] = [
  { id: 'general_hq', name: "General's HQ", minX: -14, maxX: 14, minZ: -22, maxZ: -12, floorColor: COLOR.floorHq },
  { id: 'admin_office', name: 'Admin Office', minX: -14, maxX: -3, minZ: -12, maxZ: -2, floorColor: COLOR.floorRoom },
  { id: 'waiting_area', name: 'Waiting Area', minX: 3, maxX: 14, minZ: -12, maxZ: -2, floorColor: COLOR.floorRoom },
  { id: 'north_corridor', name: 'North Corridor', minX: -3, maxX: 3, minZ: -12, maxZ: -2, floorColor: COLOR.floorCorridor },
  { id: 'cross_corridor', name: 'Cross Corridor', minX: -14, maxX: 14, minZ: -2, maxZ: 2, floorColor: COLOR.floorCorridor },
  { id: 'telegram_room', name: 'Telegram Room', minX: -14, maxX: -3, minZ: 2, maxZ: 12, floorColor: COLOR.floorRoom },
  { id: 'medical_ward', name: 'Medical Ward', minX: 3, maxX: 14, minZ: 2, maxZ: 12, floorColor: COLOR.floorRoom },
  { id: 'south_corridor', name: 'South Corridor', minX: -3, maxX: 3, minZ: 2, maxZ: 12, floorColor: COLOR.floorCorridor },
  { id: 'central_hall', name: 'Central Hall', minX: -14, maxX: 14, minZ: 12, maxZ: 22, floorColor: COLOR.floorHall },
  { id: 'security_office', name: 'Security Office', minX: -14, maxX: 0, minZ: 22, maxZ: 30, floorColor: COLOR.floorRoom },
  { id: 'storage', name: 'Storage', minX: 0, maxX: 14, minZ: 22, maxZ: 30, floorColor: COLOR.floorRoom },
  { id: 'west_corridor', name: 'West Corridor', minX: -20, maxX: -14, minZ: -22, maxZ: 30, floorColor: COLOR.floorCorridor },
  { id: 'east_corridor', name: 'East Corridor', minX: 14, maxX: 20, minZ: -22, maxZ: 30, floorColor: COLOR.floorCorridor },
];

const walls: Collider[] = [
  // --- perimeter ---
  ...wallAlongX(BOUNDS.minZ, BOUNDS.minX - t, BOUNDS.maxX + t, [], 'perimeter N'),
  ...wallAlongX(BOUNDS.maxZ, BOUNDS.minX - t, BOUNDS.maxX + t, [], 'perimeter S'),
  ...wallAlongZ(BOUNDS.minX, BOUNDS.minZ, BOUNDS.maxZ, [], 'perimeter W'),
  ...wallAlongZ(BOUNDS.maxX, BOUNDS.minZ, BOUNDS.maxZ, [], 'perimeter E'),

  // --- General HQ (north block) ---
  // Exactly ONE way in: the north corridor door. Every approach to the General is
  // therefore observable, and the corridor is a genuine chokepoint to guard.
  ...wallAlongX(-12, -14, 14, [{ at: 0 }], 'HQ south (only door)'),
  ...wallAlongZ(-14, -22, -12, [], 'HQ west'),
  ...wallAlongZ(14, -22, -12, [], 'HQ east'),

  // --- long corridor walls ---
  // Gaps here are: the Admin door, the cross-corridor junction, the Telegram door,
  // and the wide opening into Central Hall. Each ROOM still has only one way in;
  // the corridors are the connective tissue.
  ...wallAlongZ(
    -14,
    -12,
    30,
    [{ at: -7 }, { at: 0, width: 3 }, { at: 7 }, { at: 17, width: 4 }],
    'west corridor inner',
  ),
  ...wallAlongZ(
    14,
    -12,
    30,
    [{ at: -7 }, { at: 0, width: 3 }, { at: 7 }, { at: 17, width: 4 }],
    'east corridor inner',
  ),

  // --- admin / waiting band: one door each, onto the outer corridors ---
  ...wallAlongZ(-3, -12, -2, [], 'admin east'),
  ...wallAlongZ(3, -12, -2, [], 'waiting west'),
  ...wallAlongX(-2, -14, -3, [], 'admin south'),
  ...wallAlongX(-2, 3, 14, [], 'waiting south'),

  // --- telegram / medical band: one door each, onto the outer corridors ---
  ...wallAlongX(2, -14, -3, [], 'telegram north'),
  ...wallAlongX(2, 3, 14, [], 'medical north'),
  ...wallAlongZ(-3, 2, 12, [], 'telegram east'),
  ...wallAlongZ(3, 2, 12, [], 'medical west'),
  ...wallAlongX(12, -14, -3, [], 'telegram south'),
  ...wallAlongX(12, 3, 14, [], 'medical south'),

  // --- central hall / security / storage ---
  ...wallAlongX(22, -14, 14, [{ at: -7 }, { at: 7 }], 'hall south'),
  ...wallAlongZ(0, 22, 30, [], 'security/storage divider'),
];

const props: Collider[] = [
  // General HQ — the assassination target's office.
  prop(0, -19, 3.2, 0.95, 1.3, COLOR.desk, "General's desk"),
  prop(0, -14.5, 5.0, 0.8, 1.1, COLOR.desk, 'briefing table'),
  prop(-12.2, -20.5, 1.2, 2.0, 0.7, COLOR.cabinet, 'HQ cabinet'),
  prop(12.2, -20.5, 1.2, 2.0, 0.7, COLOR.cabinet, 'HQ cabinet'),
  prop(-6, -17, 0.7, 3.2, 0.7, COLOR.pillar, 'HQ pillar'),
  prop(6, -17, 0.7, 3.2, 0.7, COLOR.pillar, 'HQ pillar'),

  // Admin office — Secretary duties.
  prop(-11, -9, 1.9, 0.8, 1.0, COLOR.desk, 'admin desk'),
  prop(-11, -5, 1.9, 0.8, 1.0, COLOR.desk, 'admin desk'),
  prop(-6, -9, 1.9, 0.8, 1.0, COLOR.desk, 'admin desk'),
  prop(-13.0, -3.5, 1.4, 2.0, 0.6, COLOR.cabinet, 'records cabinet'),
  prop(-6, -4, 1.0, 0.75, 1.0, COLOR.desk, 'side table'),

  // Waiting area — where players bump into each other.
  prop(6, -10, 3.0, 0.5, 0.8, COLOR.desk, 'bench'),
  prop(6, -4, 3.0, 0.5, 0.8, COLOR.desk, 'bench'),
  prop(10.5, -7, 1.4, 0.75, 1.4, COLOR.desk, 'table'),
  prop(13.0, -11, 0.8, 1.6, 0.8, COLOR.cabinet, 'locker'),

  // Telegram room. The console row is held off the west wall: that wall now
  // carries the room's ONLY door, so the strip in front of it must stay walkable.
  prop(-11.0, 4.0, 1.7, 0.9, 1.1, COLOR.desk, 'telegram console'),
  prop(-11.0, 7.0, 1.7, 0.9, 1.1, COLOR.desk, 'telegram console'),
  prop(-11.0, 10.0, 1.7, 0.9, 1.1, COLOR.desk, 'telegram console'),
  prop(-5.0, 3.2, 1.2, 1.1, 0.6, COLOR.cabinet, 'signals drawer'),
  prop(-8, 8, 1.6, 0.8, 1.0, COLOR.desk, 'log table'),

  // Medical ward — Doctor duties.
  // Beds are 2.0 deep, not 2.2, so the gaps at either end of the row stay wide
  // enough for a 0.7m-wide player to walk round them.
  prop(5.5, 4.0, 1.0, 0.6, 2.0, COLOR.bed, 'ward bed'),
  prop(5.5, 7.0, 1.0, 0.6, 2.0, COLOR.bed, 'ward bed'),
  prop(5.5, 10.0, 1.0, 0.6, 2.0, COLOR.bed, 'ward bed'),
  prop(13.0, 3.5, 1.4, 2.0, 0.6, COLOR.cabinet, 'medical cabinet'),
  prop(10, 9, 0.9, 0.9, 0.6, COLOR.desk, 'supply trolley'),

  // Central hall — pillars give cover and break sight lines.
  prop(-7, 15, 0.8, 3.2, 0.8, COLOR.pillar, 'hall pillar'),
  prop(7, 15, 0.8, 3.2, 0.8, COLOR.pillar, 'hall pillar'),
  prop(-7, 19, 0.8, 3.2, 0.8, COLOR.pillar, 'hall pillar'),
  prop(7, 19, 0.8, 3.2, 0.8, COLOR.pillar, 'hall pillar'),
  prop(0, 20, 1.3, 0.55, 1.3, COLOR.crate, 'hall crate'), // low: step-up test
  prop(-11, 20.5, 3.0, 0.5, 0.8, COLOR.desk, 'hall bench'),

  // Security office — the officer's home base.
  prop(-10, 25, 2.0, 0.8, 1.0, COLOR.desk, 'security desk'),
  prop(-13.0, 27.5, 1.2, 2.0, 0.6, COLOR.rack, 'weapon rack'),
  prop(-4, 29.0, 3.2, 2.0, 0.6, COLOR.cabinet, 'lockers'),
  prop(-6, 24, 1.4, 0.75, 1.4, COLOR.desk, 'briefing table'),

  // Storage — less supervised, good for ambushes and hidden pistols.
  prop(3.0, 24.5, 1.4, 1.4, 1.4, COLOR.crate, 'crate stack'),
  prop(4.6, 24.5, 1.4, 0.7, 1.4, COLOR.crate, 'crate'), // low: step-up test
  prop(3.0, 27.5, 1.4, 2.1, 1.4, COLOR.crate, 'tall crate'),
  prop(8, 26, 1.2, 0.35, 3.0, COLOR.crate, 'pallet'), // very low: walk straight over
  prop(12.8, 24, 1.0, 2.2, 4.0, COLOR.rack, 'shelving'),
  prop(12.8, 29, 1.0, 2.2, 1.4, COLOR.rack, 'shelving'),
  prop(6.5, 29, 1.6, 1.0, 1.0, COLOR.cabinet, 'supply cabinet'),

  // Corridor clutter so the corridors are not featureless tubes.
  prop(-17, -6, 1.0, 1.8, 0.6, COLOR.cabinet, 'corridor locker'),
  prop(-17, 14, 1.0, 1.8, 0.6, COLOR.cabinet, 'corridor locker'),
  prop(17, 5, 1.0, 1.8, 0.6, COLOR.cabinet, 'corridor locker'),
  prop(17, 24, 1.2, 0.6, 1.2, COLOR.crate, 'corridor crate'),
];

/** Ground plane, as a collider so gravity has something to land on. */
const floor: Collider = {
  min: { x: BOUNDS.minX - 1, y: -1, z: BOUNDS.minZ - 1 },
  max: { x: BOUNDS.maxX + 1, y: 0, z: BOUNDS.maxZ + 1 },
  kind: 'floor',
  color: COLOR.floorCorridor,
  label: 'ground',
};

const spawnPoints: Vec3[] = [
  { x: -4, y: 0, z: 17 },
  { x: 4, y: 0, z: 17 },
  { x: -9, y: 0, z: 18 },
  { x: 9, y: 0, z: 18 },
  { x: 0, y: 0, z: 8 },
  { x: -17, y: 0, z: 10 },
  { x: 17, y: 0, z: 10 },
  { x: 0, y: 0, z: -6 },
];

/**
 * Where the General stands (CLAUDE.md §25): behind his desk, at the far end of
 * the only room with one door, facing it. Getting a clean shot means being
 * inside HQ with guards watching.
 */
export const GENERAL_POST = { x: 0, y: 0, z: -21.2, yaw: Math.PI };

/**
 * Restricted areas (CLAUDE.md §26 — "opportunity → risk → suspicion → action",
 * not "walk into office → click General → instantly win").
 *
 * A zone says who is allowed to be standing in it and what the guards do about
 * anyone else. This is deliberately not a suspicion score: it is a posted rule
 * that a human can learn in one round and then decide whether to break.
 */
export type ZoneResponse = 'warn' | 'shoot';

export type RestrictedZone = {
  id: string;
  label: string;
  /** Horizontal box. Y is ignored — the compound is one storey. */
  min: { x: number; z: number };
  max: { x: number; z: number };
  /** Public occupations that may be here. Everyone else is an offender. */
  allow: readonly Role[];
  /** `warn` gives the usual challenge-then-shoot; `shoot` skips the challenge. */
  response: ZoneResponse;
  /**
   * If true, a VISIBLE weapon in this zone is hostile immediately whoever is
   * holding it — including the Security Officer, who may carry a rifle
   * anywhere else in the compound. Nobody draws a weapon in front of the
   * General.
   */
  noWeapons?: boolean;
};

export const RESTRICTED_ZONES: readonly RestrictedZone[] = [
  {
    id: 'hq_interior',
    label: "GENERAL'S OFFICE",
    min: { x: -14, z: -22 },
    max: { x: 14, z: -12 },
    // Only the Secretary has business past that door, and only unarmed — if she
    // is holding anything the noWeapons rule below catches her too.
    allow: ['secretary'],
    response: 'shoot',
    noWeapons: true,
  },
  {
    id: 'hq_approach',
    label: 'RESTRICTED — HQ APPROACH',
    // The stretch of north corridor directly outside the one HQ door.
    min: { x: -3, z: -12 },
    max: { x: 3, z: -6 },
    allow: ['security', 'secretary'],
    response: 'warn',
  },
];

/**
 * The zone containing a point, or null. Zones are listed innermost-first, so
 * standing inside HQ reports HQ and not the approach.
 */
export function restrictedZoneAt(x: number, z: number): RestrictedZone | null {
  for (const zone of RESTRICTED_ZONES) {
    if (x >= zone.min.x && x <= zone.max.x && z >= zone.min.z && z <= zone.max.z) return zone;
  }
  return null;
}

/**
 * Guard posts and patrol routes (CLAUDE.md §17–§19). Routes are plain waypoint
 * loops — no pathfinding — so every straight segment between consecutive points
 * has to be walkable. They are, and `scripts/guard-tests.ts` asserts it.
 */
export type GuardPost = {
  label: string;
  /** Static sentries have a single point and a facing; patrols have a loop. */
  route: readonly { x: number; z: number }[];
  /** Facing to return to when standing a static post. */
  yaw?: number;
};

export const GUARD_POSTS: readonly GuardPost[] = [
  // Two sentries OUTSIDE the HQ door, in the corridor, facing south down it —
  // they see you coming long before you reach the handle. This is the pair that
  // enforces the hq_approach zone.
  { label: 'door sentry W', route: [{ x: -2, z: -10.2 }], yaw: Math.PI },
  { label: 'door sentry E', route: [{ x: 2, z: -10.2 }], yaw: Math.PI },

  // One inside, off to the side, watching the door from within the room. If you
  // do get through, he is already looking at it.
  { label: 'HQ sentry', route: [{ x: 3.5, z: -18.5 }], yaw: Math.atan2(3.5, -6.5) },

  // A circuit of the General's office itself.
  {
    label: 'HQ patrol',
    route: [
      { x: -9, z: -15 },
      { x: -9, z: -20 },
      { x: 9, z: -20 },
      { x: 9, z: -15 },
      { x: 0, z: -13.2 },
    ],
  },

  // The chokepoint: up the north corridor to the HQ door, then along the cross
  // corridor and back. Anyone approaching the General walks past this one.
  {
    label: 'chokepoint',
    route: [
      { x: 0, z: -11 },
      { x: 0, z: -3.5 },
      { x: 0, z: 0.8 },
      { x: -12, z: 0.8 },
      { x: 0, z: 0.8 },
      { x: 12, z: 0.8 },
      { x: 0, z: 0.8 },
      { x: 0, z: -3.5 },
    ],
  },

  // Two long loops of the west and east halves, through the Central Hall.
  {
    label: 'west circuit',
    route: [
      { x: 0, z: 17 },
      { x: -11, z: 17 },
      { x: -16, z: 17 },
      { x: -18.5, z: 15 },
      { x: -18.5, z: 2 },
      { x: -16, z: 0 },
      { x: -11, z: 0 },
      { x: 0, z: 0.8 },
      { x: 0, z: 8 },
      { x: 0, z: 15 },
    ],
  },
  {
    label: 'east circuit',
    route: [
      { x: 0, z: 17 },
      { x: 11, z: 17 },
      { x: 16, z: 17 },
      { x: 18.5, z: 15 },
      { x: 18.5, z: 2 },
      { x: 16, z: 0 },
      { x: 11, z: 0 },
      { x: 0, z: 0.8 },
      { x: 0, z: 8 },
      { x: 0, z: 15 },
    ],
  },
];

/**
 * Candidate spots for hidden pistols (CLAUDE.md §23) — beside a drawer, a
 * cabinet or a crate, in rooms with a legitimate reason to visit. Only a few of
 * these are used per round, chosen at random, so nobody can memorise the map.
 */
export const HIDDEN_PISTOL_SPOTS: readonly Vec3[] = [
  { x: 6.0, y: 0, z: 28.0 }, // storage, by the supply cabinet
  { x: -5.0, y: 0, z: 4.3 }, // telegram room, by the signals drawer
  { x: -12.6, y: 0, z: -4.5 }, // admin office, by the records cabinet
  { x: 11.8, y: 0, z: 4.3 }, // medical ward, by the cabinet
  { x: 11.9, y: 0, z: -10.8 }, // waiting area, by the locker
];

/**
 * Where the Security Officer is sent on patrol (CLAUDE.md §15).
 *
 * Each one is an existing room, inset a metre so that "reached it" means
 * properly inside rather than brushing the doorframe. The list is spread across
 * the compound and deliberately includes the two rooms an officer would
 * otherwise never have a reason to enter — Storage and the Medical Ward —
 * because the entire point of the duty is to pull him away from the General.
 *
 * The General's HQ is NOT on the list. A patrol that legitimised standing in
 * the General's office would defeat the mechanic.
 */
export type PatrolCheckpoint = {
  id: RoomId;
  label: string;
  min: { x: number; z: number };
  max: { x: number; z: number };
};

const PATROL_ROOMS: readonly RoomId[] = [
  'storage',
  'telegram_room',
  'medical_ward',
  'waiting_area',
  'admin_office',
  'central_hall',
];

/** Metres in from the room's walls, so a doorframe brush does not count. */
const CHECKPOINT_INSET = 1;

export const PATROL_CHECKPOINTS: readonly PatrolCheckpoint[] = PATROL_ROOMS.map((id) => {
  const room = rooms.find((r) => r.id === id);
  if (!room) throw new Error(`patrol checkpoint names no room: ${id}`);
  return {
    id,
    label: room.name.toUpperCase(),
    min: { x: room.minX + CHECKPOINT_INSET, z: room.minZ + CHECKPOINT_INSET },
    max: { x: room.maxX - CHECKPOINT_INSET, z: room.maxZ - CHECKPOINT_INSET },
  };
});

/** True when (x, z) is properly inside the checkpoint box. */
export function insideCheckpoint(cp: PatrolCheckpoint, x: number, z: number): boolean {
  return x >= cp.min.x && x <= cp.max.x && z >= cp.min.z && z <= cp.max.z;
}

export const COMPOUND: CompoundMap = {
  bounds: BOUNDS,
  rooms,
  colliders: [floor, ...walls, ...props],
  spawnPoints,
};

export const ROOM_COLORS = COLOR;
