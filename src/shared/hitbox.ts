/**
 * Character hit regions (CLAUDE.md §13).
 *
 * BODY_SEGMENTS drives BOTH the visible character mesh and these hit boxes, so a
 * shot that *looks* like a head shot is a head shot. Nothing else in the codebase
 * may hard-code a body dimension — change it here and the visual and the hitbox
 * move together.
 *
 * Local space: origin at the FEET, character faces -Z at yaw 0, +Y up.
 *
 * With that basis the character's own RIGHT is +X. (Convention check against the
 * map: +X is east and north is -Z, so someone facing north has east on their
 * right.) An earlier version of this file claimed the opposite and mirrored every
 * limb — see the note in CharacterMesh.
 */
import { rayBox } from './collision';
import type { Box, Vec3 } from './types';

export const BODY_SEGMENTS = {
  legHeight: 0.85,
  torsoHeight: 0.63,
  headSize: 0.28,
  torsoWidth: 0.52,
  torsoDepth: 0.3,
  armWidth: 0.16,
  armLength: 0.6,
  /** Distance from the body centre line to an arm's centre. */
  armOffset: 0.35,
  legWidth: 0.19,
  legDepth: 0.22,
  legOffset: 0.13,
  /** Gap between the top of the torso and the bottom of the head mesh. */
  neckGap: 0.04,
} as const;

export type HitRegion = 'head' | 'torso' | 'left_arm' | 'right_arm' | 'left_leg' | 'right_leg';

/** Damage rules care about the class, not which arm (CLAUDE.md §12). */
export type HitClass = 'head' | 'torso' | 'limb';

export const HIT_CLASS: Record<HitRegion, HitClass> = {
  head: 'head',
  torso: 'torso',
  left_arm: 'limb',
  right_arm: 'limb',
  left_leg: 'limb',
  right_leg: 'limb',
};

const s = BODY_SEGMENTS;
const TORSO_TOP = s.legHeight + s.torsoHeight;
const HEAD_TOP = TORSO_TOP + s.headSize + s.neckGap;
const ARM_TOP = TORSO_TOP - 0.03;

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Box {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * The regions, in local space. The head box starts at the top of the torso
 * rather than at the head mesh so a ray cannot slip through the neck gap.
 */
export const HITBOXES: readonly { region: HitRegion; box: Box }[] = [
  {
    region: 'head',
    box: box(-s.headSize / 2, TORSO_TOP, -s.headSize / 2, s.headSize / 2, HEAD_TOP, s.headSize / 2),
  },
  {
    region: 'torso',
    box: box(
      -s.torsoWidth / 2,
      s.legHeight,
      -s.torsoDepth / 2,
      s.torsoWidth / 2,
      TORSO_TOP,
      s.torsoDepth / 2,
    ),
  },
  // Left is -X, right is +X — the character's own left and right, not the viewer's.
  {
    region: 'left_arm',
    box: box(
      -s.armOffset - s.armWidth / 2,
      ARM_TOP - s.armLength,
      -0.1,
      -s.armOffset + s.armWidth / 2,
      ARM_TOP,
      0.1,
    ),
  },
  {
    region: 'right_arm',
    box: box(
      s.armOffset - s.armWidth / 2,
      ARM_TOP - s.armLength,
      -0.1,
      s.armOffset + s.armWidth / 2,
      ARM_TOP,
      0.1,
    ),
  },
  {
    region: 'left_leg',
    box: box(
      -s.legOffset - s.legWidth / 2,
      0,
      -s.legDepth / 2,
      -s.legOffset + s.legWidth / 2,
      s.legHeight,
      s.legDepth / 2,
    ),
  },
  {
    region: 'right_leg',
    box: box(
      s.legOffset - s.legWidth / 2,
      0,
      -s.legDepth / 2,
      s.legOffset + s.legWidth / 2,
      s.legHeight,
      s.legDepth / 2,
    ),
  },
];

/** Cheap early-out: a sphere that contains every hit box. */
export const BODY_BOUND_RADIUS = 1.05;
export const BODY_BOUND_CENTER_Y = HEAD_TOP / 2;

export type CharacterHit = {
  region: HitRegion;
  distance: number;
  point: Vec3;
};

/**
 * Ray against one character's hit boxes. The ray is transformed into the
 * character's local space rather than the boxes into world space — six box
 * rotations per character per shot would be pointless work.
 *
 * @param feet world position of the character's feet
 * @param yaw  the character's facing, matching `mesh.rotation.y`
 */
export function raycastCharacter(
  origin: Vec3,
  direction: Vec3,
  feet: Vec3,
  yaw: number,
  maxDistance: number,
): CharacterHit | null {
  // Bounding-sphere reject before doing any real work.
  const cx = feet.x - origin.x;
  const cy = feet.y + BODY_BOUND_CENTER_Y - origin.y;
  const cz = feet.z - origin.z;
  const along = cx * direction.x + cy * direction.y + cz * direction.z;
  if (along < -BODY_BOUND_RADIUS || along > maxDistance + BODY_BOUND_RADIUS) return null;
  const clamped = Math.max(0, Math.min(maxDistance, along));
  const px = cx - direction.x * clamped;
  const py = cy - direction.y * clamped;
  const pz = cz - direction.z * clamped;
  if (px * px + py * py + pz * pz > BODY_BOUND_RADIUS * BODY_BOUND_RADIUS) return null;

  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  const rx = origin.x - feet.x;
  const rz = origin.z - feet.z;
  const localOrigin: Vec3 = {
    x: rx * cos - rz * sin,
    y: origin.y - feet.y,
    z: rx * sin + rz * cos,
  };
  const localDir: Vec3 = {
    x: direction.x * cos - direction.z * sin,
    y: direction.y,
    z: direction.x * sin + direction.z * cos,
  };

  let best: CharacterHit | null = null;
  for (const part of HITBOXES) {
    const hit = rayBox(localOrigin, localDir, part.box, maxDistance);
    if (!hit) continue;
    if (best && hit.distance >= best.distance) continue;
    best = {
      region: part.region,
      distance: hit.distance,
      point: {
        x: origin.x + direction.x * hit.distance,
        y: origin.y + direction.y * hit.distance,
        z: origin.z + direction.z * hit.distance,
      },
    };
  }
  return best;
}
