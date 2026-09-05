/**
 * Doors (CLAUDE.md §9, §27 — the compound's rooms are supposed to be rooms).
 *
 * A door is a hole in a wall that can be filled in. `mapData.ts` already cuts
 * those holes: every `Gap` passed to `wallAlongX`/`wallAlongZ` is a doorway, and
 * the seven listed below are the ones that lead into an actual ROOM. The wide
 * junctions — the 3 m cross-corridor gaps and the 4 m openings into Central Hall
 * — get no door; they are the compound's arteries and a door there would only be
 * something to get stuck in.
 *
 * The important architectural decision is what a door is NOT: it is not a member
 * of `COMPOUND.colliders`. That list is the static world, and `navgrid.ts` bakes
 * it into a single grid at module load. A shut door in there would repartition
 * the compound and strand every guard on the wrong side of it. So doors live
 * here, in a `DoorField` that hands out `COMPOUND.colliders` PLUS a leaf per shut
 * door, and the nav grid keeps seeing the compound with every door open. Guards
 * simply open what they walk into (`openNear`), which is what a man with keys
 * would do anyway.
 *
 * State is a set of open ids, and nothing closes a door by itself. A door left
 * open is a trace: somebody went through there and did not tidy up after
 * themselves, and another player can read that off the map.
 */
import { GAME_CONFIG } from './constants';
import { COMPOUND } from './mapData';
import type { Collider } from './types';

const { wallHeight, wallThickness, doorWidth, doorReach } = GAME_CONFIG.world;

/**
 * One door leaf.
 *
 * `axis` is the direction the doorway SPANS: 'x' for a door in an east-west
 * wall, 'z' for one in a north-south wall. The hinge is always at the low
 * coordinate end of that span, and `swing` is the sign of the rotation about Y
 * that opens it — chosen per door so the leaf swings into the room rather than
 * out into the corridor where people walk.
 */
export type DoorDef = {
  id: number;
  /** Shown on the [E] prompt, so it reads as a place and not a number. */
  label: string;
  x: number;
  z: number;
  axis: 'x' | 'z';
  width: number;
  swing: 1 | -1;
};

const t = wallThickness / 2;

/**
 * The seven room doors, in the order their doorways appear in `mapData.ts`.
 * Ids are positional and are sent over the wire, so appending is safe and
 * reordering is not.
 */
export const DOORS: readonly DoorDef[] = [
  // HQ south wall, z=-12, gap at x=0. The only way into the General's office.
  { id: 0, label: "General's HQ", x: 0, z: -12, axis: 'x', width: doorWidth, swing: 1 },
  // West corridor inner wall, x=-14.
  { id: 1, label: 'Admin Office', x: -14, z: -7, axis: 'z', width: doorWidth, swing: 1 },
  { id: 2, label: 'Telegram Room', x: -14, z: 7, axis: 'z', width: doorWidth, swing: 1 },
  // East corridor inner wall, x=14.
  { id: 3, label: 'Waiting Area', x: 14, z: -7, axis: 'z', width: doorWidth, swing: -1 },
  { id: 4, label: 'Medical Ward', x: 14, z: 7, axis: 'z', width: doorWidth, swing: -1 },
  // Hall south wall, z=22.
  { id: 5, label: 'Security Office', x: -7, z: 22, axis: 'x', width: doorWidth, swing: -1 },
  { id: 6, label: 'Storage', x: 7, z: 22, axis: 'x', width: doorWidth, swing: -1 },
];

const BY_ID = new Map(DOORS.map((d) => [d.id, d]));

export function doorById(id: number): DoorDef | undefined {
  return BY_ID.get(id);
}

/** The box a shut door fills — exactly the hole `mapData` cut for it. */
export function doorCollider(def: DoorDef): Collider {
  const halfSpan = def.width / 2;
  const [hx, hz] = def.axis === 'x' ? [halfSpan, t] : [t, halfSpan];
  return {
    min: { x: def.x - hx, y: 0, z: def.z - hz },
    max: { x: def.x + hx, y: wallHeight, z: def.z + hz },
    kind: 'wall',
    color: 0x6b573c,
    label: `${def.label} door`,
  };
}

/** Where the hinge sits, in world space. Rendering needs it; collision does not. */
export function doorHinge(def: DoorDef): { x: number; z: number } {
  return def.axis === 'x'
    ? { x: def.x - def.width / 2, z: def.z }
    : { x: def.x, z: def.z - def.width / 2 };
}

/**
 * Which doors are open, and the world geometry that follows from it.
 *
 * Shared by the client and the server, and instantiated separately on each: the
 * server's copy is authoritative and the client's is a mirror it is told about,
 * except in offline solo mode where the client's copy is all there is.
 */
export class DoorField {
  private readonly open = new Set<number>();
  private cache: readonly Collider[] | null = null;

  isOpen(id: number): boolean {
    return this.open.has(id);
  }

  openIds(): number[] {
    return [...this.open].sort((a, b) => a - b);
  }

  /** Returns the door's new state. Unknown ids are ignored and report shut. */
  toggle(id: number): boolean {
    if (!BY_ID.has(id)) return false;
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    this.cache = null;
    return this.open.has(id);
  }

  /** Adopt a full state from the server. */
  setAll(open: readonly number[]): void {
    this.open.clear();
    for (const id of open) if (BY_ID.has(id)) this.open.add(id);
    this.cache = null;
  }

  /**
   * Push open every shut door within `radius`. This is how guards get through
   * the compound without the nav grid ever having to know a door exists — see
   * the note at the top of this file. Returns the ids that changed.
   */
  openNear(x: number, z: number, radius: number): number[] {
    let changed: number[] | null = null;
    for (const def of DOORS) {
      if (this.open.has(def.id)) continue;
      if (Math.hypot(def.x - x, def.z - z) > radius) continue;
      this.open.add(def.id);
      (changed ??= []).push(def.id);
    }
    if (changed) this.cache = null;
    return changed ?? [];
  }

  /** The nearest door a player at (x, z) could reach, or null. */
  nearest(x: number, z: number, reach: number = doorReach): DoorDef | null {
    let best: DoorDef | null = null;
    let bestDistance = reach;
    for (const def of DOORS) {
      const d = Math.hypot(def.x - x, def.z - z);
      if (d > bestDistance) continue;
      best = def;
      bestDistance = d;
    }
    return best;
  }

  /**
   * The static compound plus a leaf for every SHUT door — the list every
   * movement, camera, line-of-sight and hitscan query should be run against.
   *
   * Rebuilt only when a door moves, because it is asked for several times per
   * frame per player and is otherwise identical from one frame to the next.
   */
  solids(): readonly Collider[] {
    if (this.cache) return this.cache;
    const out: Collider[] = [...COMPOUND.colliders];
    for (const def of DOORS) {
      if (!this.open.has(def.id)) out.push(doorCollider(def));
    }
    this.cache = out;
    return out;
  }
}
