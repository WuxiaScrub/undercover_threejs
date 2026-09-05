/**
 * Hit resolution and damage (CLAUDE.md §12, §40). Pure math, no three.js, no
 * networking — the server runs this authoritatively, and the client runs the
 * same code against debug bots in solo mode so both agree by construction.
 *
 * Bullet damage is FLAT (weapon × hit class) and identical whoever it hits. How
 * many shots a body absorbs is therefore a property of the body — see the health
 * column of ROLE_STATS — not of the gun. Head damage exceeds every role's health,
 * so a head shot is always one shot.
 */
import { raycastColliders } from './collision';
import { GAME_CONFIG } from './constants';
import { HIT_CLASS, raycastCharacter, type HitRegion } from './hitbox';
import { ROLE_STATS, type Role } from './roles';
import type { Collider, Vec3 } from './types';
import { WEAPONS, type WeaponId } from './weapons';

/** Damage one shot deals, wherever it lands and whoever it lands on. */
export function damageFor(weapon: WeaponId, region: HitRegion): number {
  return WEAPONS[weapon].damage[HIT_CLASS[region]];
}

/** Damage an unarmed strike deals. Flat per attacking role (CLAUDE.md §10 style). */
export function meleeDamageFor(attacker: Role): number {
  return ROLE_STATS[attacker].meleeDamage;
}

/** Anything that can be shot: players now, guards and the General in milestone 4. */
export type CombatTarget = {
  id: number;
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
};

export type ShotOutcome =
  | { kind: 'hit'; targetId: number; region: HitRegion; point: Vec3; distance: number }
  | { kind: 'wall'; point: Vec3; distance: number }
  | { kind: 'miss'; point: Vec3; distance: number };

/**
 * Hitscan (CLAUDE.md §12). The nearest thing along the ray wins, world geometry
 * included — which is what makes cover work: a wall in front of a body means the
 * wall is hit, not the body.
 */
export function resolveShot(
  origin: Vec3,
  direction: Vec3,
  weapon: WeaponId,
  targets: readonly CombatTarget[],
  colliders: readonly Collider[],
  shooterId: number,
): ShotOutcome {
  const range = WEAPONS[weapon].range;

  let bestDistance = range;
  let hit: { targetId: number; region: HitRegion; point: Vec3 } | null = null;

  const wall = raycastColliders(origin, direction, range, colliders);
  if (wall) bestDistance = wall.distance;

  for (const target of targets) {
    if (!target.alive || target.id === shooterId) continue;
    const body = raycastCharacter(origin, direction, target, target.yaw, bestDistance);
    if (!body) continue;
    bestDistance = body.distance;
    hit = { targetId: target.id, region: body.region, point: body.point };
  }

  if (hit) return { kind: 'hit', ...hit, distance: bestDistance };
  if (wall && bestDistance === wall.distance) {
    return { kind: 'wall', point: wall.point, distance: wall.distance };
  }
  return {
    kind: 'miss',
    point: {
      x: origin.x + direction.x * range,
      y: origin.y + direction.y * range,
      z: origin.z + direction.z * range,
    },
    distance: range,
  };
}

/**
 * Unarmed strike: the nearest live target in a short cone in front of the
 * attacker, with line of sight so you cannot punch through a door.
 */
export function resolveMelee(
  origin: Vec3,
  direction: Vec3,
  targets: readonly CombatTarget[],
  colliders: readonly Collider[],
  attackerId: number,
): CombatTarget | null {
  const { range, halfAngle } = GAME_CONFIG.combat.melee;
  const cosLimit = Math.cos(halfAngle);

  let best: CombatTarget | null = null;
  let bestDistance = Infinity;

  for (const target of targets) {
    if (!target.alive || target.id === attackerId) continue;

    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const flat = Math.hypot(dx, dz);
    if (flat > range || flat < 1e-4) continue;
    // Chest height, so crouching/jumping does not matter for a punch.
    const dy = target.y + 1.2 - origin.y;
    if (Math.abs(dy) > 1.6) continue;

    if ((dx / flat) * direction.x + (dz / flat) * direction.z < cosLimit) continue;
    if (flat >= bestDistance) continue;

    const len = Math.hypot(dx, dy, dz);
    const los: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
    const blocked = raycastColliders(origin, los, len, colliders);
    if (blocked) continue;

    best = target;
    bestDistance = flat;
  }

  return best;
}
