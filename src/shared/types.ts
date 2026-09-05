/** Plain data types shared by the client and (later) the server. No three.js here. */

export type Vec3 = { x: number; y: number; z: number };

/** Axis-aligned box in world space. Used for both rendering and collision. */
export type Box = {
  min: Vec3;
  max: Vec3;
};

export type ColliderKind = 'wall' | 'prop' | 'floor';

export type Collider = Box & {
  kind: ColliderKind;
  /** Purely cosmetic; collision never looks at this. */
  color: number;
  /** Human-readable tag, handy in the debug overlay. */
  label?: string;
};

export type RoomId =
  | 'general_hq'
  | 'admin_office'
  | 'waiting_area'
  | 'telegram_room'
  | 'medical_ward'
  | 'central_hall'
  | 'security_office'
  | 'storage'
  | 'west_corridor'
  | 'east_corridor'
  | 'cross_corridor'
  | 'north_corridor'
  | 'south_corridor';

export type Room = {
  id: RoomId;
  name: string;
  /** Footprint on the XZ plane. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorColor: number;
};

export type CompoundMap = {
  /** Outer extent of the whole compound, used for out-of-bounds checks. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  rooms: Room[];
  colliders: Collider[];
  spawnPoints: Vec3[];
};
