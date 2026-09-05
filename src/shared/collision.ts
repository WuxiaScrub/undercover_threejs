/**
 * Capsule-vs-static-AABB collision (CLAUDE.md §9). Pure math, no three.js, so the
 * server can run exactly the same code for line-of-sight and shot occlusion.
 *
 * The player is treated as a vertical cylinder (radius + height) rather than a
 * true capsule: against a world made entirely of boxes it behaves identically
 * for walking, and it slides around corners without the grabbiness of an AABB.
 */
import { GAME_CONFIG } from './constants';
import type { Box, Collider, Vec3 } from './types';

const EPS = 1e-3;

export type Body = {
  /** Position of the FEET, not the centre. */
  position: Vec3;
  velocity: Vec3;
  radius: number;
  height: number;
  grounded: boolean;
};

/**
 * Another character to collide against: a vertical cylinder standing on `y`.
 * Unlike world colliders these move, so they get no step-up — you bump into a
 * person, you do not climb them.
 */
export type Actor = {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
};

export type MoveResult = {
  grounded: boolean;
  hitWall: boolean;
  steppedUp: boolean;
  landed: boolean;
};

export type RayHit = {
  distance: number;
  collider: Collider;
  point: Vec3;
  normal: Vec3;
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Push vector that separates a circle from a box footprint, or null if clear.
 * Returned direction is a unit vector in XZ; `depth` is how far to move along it.
 */
function circlePush(
  cx: number,
  cz: number,
  radius: number,
  c: Collider,
): { x: number; z: number; depth: number } | null {
  const nx = clamp(cx, c.min.x, c.max.x);
  const nz = clamp(cz, c.min.z, c.max.z);
  const dx = cx - nx;
  const dz = cz - nz;
  const d2 = dx * dx + dz * dz;

  if (d2 > radius * radius) return null;

  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    return { x: dx / d, z: dz / d, depth: radius - d };
  }

  // Centre is inside the footprint — escape along the shallowest axis.
  const west = cx - c.min.x;
  const east = c.max.x - cx;
  const north = cz - c.min.z;
  const south = c.max.z - cz;
  const m = Math.min(west, east, north, south);
  if (m === west) return { x: -1, z: 0, depth: west + radius };
  if (m === east) return { x: 1, z: 0, depth: east + radius };
  if (m === north) return { x: 0, z: -1, depth: north + radius };
  return { x: 0, z: 1, depth: south + radius };
}

function overlapsHorizontally(pos: Vec3, radius: number, c: Collider): boolean {
  const nx = clamp(pos.x, c.min.x, c.max.x);
  const nz = clamp(pos.z, c.min.z, c.max.z);
  const dx = pos.x - nx;
  const dz = pos.z - nz;
  return dx * dx + dz * dz <= radius * radius;
}

function overlapsVertically(feet: number, height: number, c: Box): boolean {
  return feet < c.max.y - EPS && feet + height > c.min.y + EPS;
}

/** Is there room for the body to stand with its feet at `feet`, ignoring `ignore`? */
function isClear(
  pos: Vec3,
  feet: number,
  radius: number,
  height: number,
  colliders: readonly Collider[],
  ignore: Collider,
): boolean {
  for (const c of colliders) {
    if (c === ignore) continue;
    if (!overlapsVertically(feet, height, c)) continue;
    if (overlapsHorizontally({ x: pos.x, y: feet, z: pos.z }, radius, c)) return false;
  }
  return true;
}

/**
 * Is there room for a body of this radius to stand at (x,z) on the ground?
 *
 * The predicate `moveBody` uses, hoisted so pathfinding asks the SAME question
 * the physics answers: anything whose top is above `stepHeight` is a wall, and
 * anything at or below it is a threshold you walk over. Two implementations of
 * "walkable" would drift, and a guard would route himself into a crate.
 */
export function standingClear(
  x: number,
  z: number,
  radius: number,
  colliders: readonly Collider[],
): boolean {
  const { stepHeight, height } = GAME_CONFIG.player;
  const pos: Vec3 = { x, y: stepHeight, z };
  for (const c of colliders) {
    if (c.max.y <= stepHeight + EPS) continue; // low enough to step onto
    if (!overlapsVertically(stepHeight, height, c)) continue;
    if (overlapsHorizontally(pos, radius, c)) return false;
  }
  return true;
}

/**
 * Integrate one physics step and resolve collisions.
 * Velocity is mutated in place: motion into a surface is cancelled.
 */
export function moveBody(
  body: Body,
  dt: number,
  colliders: readonly Collider[],
  actors: readonly Actor[] = [],
): MoveResult {
  const { stepHeight, groundSnapDistance } = GAME_CONFIG.player;
  const { radius, height } = body;
  const wasGrounded = body.grounded;

  let grounded = false;
  let hitWall = false;
  let steppedUp = false;

  // ---- vertical ----
  const prevFeet = body.position.y;
  body.position.y += body.velocity.y * dt;

  for (const c of colliders) {
    if (!overlapsHorizontally(body.position, radius, c)) continue;
    if (!overlapsVertically(body.position.y, height, c)) continue;

    if (body.velocity.y <= 0 && prevFeet >= c.max.y - 0.02) {
      // Landing on top of it.
      body.position.y = c.max.y;
      body.velocity.y = 0;
      grounded = true;
    } else if (body.velocity.y > 0 && prevFeet + height <= c.min.y + 0.02) {
      // Head into a ceiling.
      body.position.y = c.min.y - height;
      body.velocity.y = 0;
    }
  }

  const landed = grounded && !wasGrounded;

  // ---- horizontal ----
  body.position.x += body.velocity.x * dt;
  body.position.z += body.velocity.z * dt;

  for (let iteration = 0; iteration < 3; iteration++) {
    let resolvedAny = false;

    // Other characters first, walls second: whatever a shove does, the wall pass
    // that follows gets the last word, so nobody can be pushed through geometry.
    for (const a of actors) {
      if (body.position.y >= a.y + a.height - EPS) continue;
      if (body.position.y + height <= a.y + EPS) continue;

      const dx = body.position.x - a.x;
      const dz = body.position.z - a.z;
      const reach = radius + a.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;

      let nx = 0;
      let nz = 1;
      let depth = reach;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        nz = dz / d;
        depth = reach - d;
      }

      body.position.x += nx * depth;
      body.position.z += nz * depth;

      const intoSurface = body.velocity.x * nx + body.velocity.z * nz;
      if (intoSurface < 0) {
        body.velocity.x -= intoSurface * nx;
        body.velocity.z -= intoSurface * nz;
      }

      resolvedAny = true;
    }

    for (const c of colliders) {
      if (!overlapsVertically(body.position.y, height, c)) continue;
      const push = circlePush(body.position.x, body.position.z, radius, c);
      if (!push) continue;

      // Low obstacle we can simply walk up onto (door thresholds, pallets, crates).
      const rise = c.max.y - body.position.y;
      if (
        (grounded || wasGrounded) &&
        rise > EPS &&
        rise <= stepHeight &&
        isClear(body.position, c.max.y, radius, height, colliders, c)
      ) {
        body.position.y = c.max.y;
        if (body.velocity.y < 0) body.velocity.y = 0;
        grounded = true;
        steppedUp = true;
        resolvedAny = true;
        continue;
      }

      body.position.x += push.x * push.depth;
      body.position.z += push.z * push.depth;

      const intoSurface = body.velocity.x * push.x + body.velocity.z * push.z;
      if (intoSurface < 0) {
        body.velocity.x -= intoSurface * push.x;
        body.velocity.z -= intoSurface * push.z;
      }

      hitWall = true;
      resolvedAny = true;
    }

    if (!resolvedAny) break;
  }

  // ---- ground snap: keeps us glued to the floor walking down small steps ----
  if (!grounded && body.velocity.y <= 0) {
    let bestTop = -Infinity;
    for (const c of colliders) {
      if (c.max.y > body.position.y + EPS) continue;
      if (c.max.y < body.position.y - groundSnapDistance) continue;
      if (!overlapsHorizontally(body.position, radius, c)) continue;
      if (c.max.y > bestTop) bestTop = c.max.y;
    }
    if (bestTop > -Infinity && wasGrounded) {
      body.position.y = bestTop;
      body.velocity.y = 0;
      grounded = true;
    }
  }

  body.grounded = grounded;
  return { grounded, hitWall, steppedUp, landed };
}

/**
 * Nearest ray/box intersection. Used for camera occlusion now; guard
 * line-of-sight and server-side hitscan in later milestones.
 */
export function raycastColliders(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  colliders: readonly Collider[],
  filter?: (c: Collider) => boolean,
): RayHit | null {
  let best: RayHit | null = null;

  for (const c of colliders) {
    if (filter && !filter(c)) continue;
    const hit = rayBox(origin, direction, c, maxDistance);
    if (!hit) continue;
    if (!best || hit.distance < best.distance) best = { ...hit, collider: c };
  }

  return best;
}

export type BoxHit = {
  distance: number;
  point: Vec3;
  normal: Vec3;
};

/** Slab test. Exported so hit regions can reuse it in a character's local space. */
export function rayBox(origin: Vec3, dir: Vec3, c: Box, maxDistance: number): BoxHit | null {
  let tmin = 0;
  let tmax = maxDistance;
  let axis: 'x' | 'y' | 'z' = 'x';
  let sign = 1;

  for (const k of ['x', 'y', 'z'] as const) {
    const d = dir[k];
    const o = origin[k];
    const lo = c.min[k];
    const hi = c.max[k];

    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }

    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = k;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  const normal: Vec3 = { x: 0, y: 0, z: 0 };
  normal[axis] = sign;

  return {
    distance: tmin,
    point: {
      x: origin.x + dir.x * tmin,
      y: origin.y + dir.y * tmin,
      z: origin.z + dir.z * tmin,
    },
    normal,
  };
}
