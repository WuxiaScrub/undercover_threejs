/**
 * Doors, checked the way they are actually used (CLAUDE.md §37).
 *
 * A door is only worth having if it does two things: stop a body walking
 * through the doorway, and stop a bullet and a guard's eyes crossing it. Both
 * are one-line queries against `DoorField.solids()`, and both are asserted here
 * for every door on the map rather than for one hand-picked one.
 *
 * The third assertion is the one that protects the architecture: the nav grid
 * must be blind to all of this. If a shut door ever starts blocking a path,
 * guards strand themselves behind their own doors and the whole compound
 * repartitions the moment somebody pulls one closed.
 */
import { GAME_CONFIG } from '../src/shared/constants';
import { DOORS, DoorField, doorHinge } from '../src/shared/doors';
import { raycastColliders, standingClear } from '../src/shared/collision';
import { COMPOUND } from '../src/shared/mapData';
import type { RoomId } from '../src/shared/types';
import { findPath } from '../src/shared/navgrid';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const radius = GAME_CONFIG.player.radius;

console.log('=== a shut door is a wall, an open one is a hole ===');
for (const def of DOORS) {
  // Every door starts shut, so one toggle opens it.
  const shutClear = !standingClear(def.x, def.z, radius, new DoorField().solids());

  const doors = new DoorField();
  doors.toggle(def.id);
  const openClear = standingClear(def.x, def.z, radius, doors.solids());

  check(
    `${def.label}: walkable open, blocked shut`,
    openClear && shutClear,
    `open=${openClear ? 'clear' : 'BLOCKED'}, shut=${shutClear ? 'blocked' : 'STILL CLEAR'}`,
  );
}

console.log('\n=== a shut door stops a bullet, and a guard\'s line of sight ===');
for (const def of DOORS) {
  // Fire across the doorway, perpendicular to the wall it sits in, from 2 m out.
  const dir = def.axis === 'x' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const origin = {
    x: def.x - dir.x * 2,
    y: GAME_CONFIG.player.eyeHeight,
    z: def.z - dir.z * 2,
  };

  const shut = new DoorField();
  const blocked = raycastColliders(origin, dir, 4, shut.solids());

  const open = new DoorField();
  open.toggle(def.id);
  const clear = raycastColliders(origin, dir, 4, open.solids());

  check(
    `${def.label}: shot stopped shut, clean through open`,
    blocked !== null && clear === null,
    `shut=${blocked ? `hit ${blocked.collider.label ?? '?'}` : 'MISSED'}, open=${clear ? `HIT ${clear.collider.label ?? '?'}` : 'clear'}`,
  );
}

console.log('\n=== the nav grid never sees a door ===');
{
  // Every door shut. Guards must still be able to path into every room, because
  // they open what they walk into rather than routing around it.
  const shut = new DoorField();
  check(
    'all doors shut, and none of them is in COMPOUND.colliders',
    !COMPOUND.colliders.some((c) => c.label?.endsWith(' door')),
    `${shut.solids().length - COMPOUND.colliders.length} leaves added on top of ${COMPOUND.colliders.length} static colliders`,
  );

  // Corridor outside the Security Office, to a spot well inside it.
  const path = findPath({ x: -7, z: 19 }, { x: -7, z: 26 });
  check(
    'a guard can still path through a shut door',
    path !== null && path.length > 0,
    path ? `${path.length} waypoints` : 'NO PATH — the grid has been told about doors',
  );
}

console.log('\n=== guards open what they walk into ===');
{
  const doors = new DoorField();
  const def = DOORS[5]; // Security Office
  const hinge = doorHinge(def);
  const far = doors.openNear(hinge.x, hinge.z + 10, GAME_CONFIG.world.guardDoorOpenRadius);
  const near = doors.openNear(def.x, def.z, GAME_CONFIG.world.guardDoorOpenRadius);
  check(
    'a guard standing on the door opens it, one across the room does not',
    far.length === 0 && near.includes(def.id),
    `10 m away opened ${far.length}, on the threshold opened [${near.join(', ')}]`,
  );
}

console.log('\n=== every leaf swings into its room, not into the corridor ===');
{
  // The corridors are where people walk. A door that swings out into one is a
  // thing to trip over, and the sign that decides it — `DoorDef.swing` — is a
  // single character per door, easy to get wrong and invisible until somebody
  // opens it in game. So swing each leaf on paper and check where its far edge
  // lands: it must end up inside the named room.
  const rooms = new Map(COMPOUND.rooms.map((r) => [r.id, r]));
  const expected: Record<number, RoomId> = {
    0: 'general_hq',
    1: 'admin_office',
    2: 'telegram_room',
    3: 'waiting_area',
    4: 'medical_ward',
    5: 'security_office',
    6: 'storage',
  };

  for (const def of DOORS) {
    const room = rooms.get(expected[def.id])!;
    const hinge = doorHinge(def);
    // The leaf's far edge, in pivot-local space, before it is swung.
    const local = def.axis === 'x' ? { x: def.width, z: 0 } : { x: 0, z: def.width };
    const angle = (def.swing * Math.PI) / 2;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    // THREE's rotation about +Y.
    const tip = {
      x: hinge.x + local.x * cos + local.z * sin,
      z: hinge.z - local.x * sin + local.z * cos,
    };
    // Nudge off the wall plane: the tip lands exactly on a room boundary in the
    // axis it did NOT move along, and >= / <= would pass either way there.
    const inside =
      tip.x > room.minX - 1e-6 &&
      tip.x < room.maxX + 1e-6 &&
      tip.z > room.minZ - 1e-6 &&
      tip.z < room.maxZ + 1e-6;
    check(
      `${def.label}: opens inward`,
      inside,
      `leaf tip (${tip.x.toFixed(1)}, ${tip.z.toFixed(1)}) vs ${room.id} ` +
        `x[${room.minX}, ${room.maxX}] z[${room.minZ}, ${room.maxZ}]`,
    );
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
