/**
 * Pathfinding tests (CLAUDE.md §37 — "guards ... doors ... corners").
 *
 * Guards used to walk the straight line at whatever they were going to, which
 * in a compound of one-door rooms means walking into a wall and standing there.
 * A gunshot in Storage left the chokepoint guard pressed against the
 * cross-corridor wall 24.6 m short of it. This asserts that is over, against
 * the same `NpcWorld` the server ticks and offline solo mode ticks.
 *
 * Two separate claims, and both matter:
 *   1. `findPath` returns routes that exist and are actually standable.
 *   2. A guard WALKING one of those routes arrives — string-pulling, waypoint
 *      popping and body collision all have to agree, and the doorway jam was a
 *      disagreement between them, not a bad route.
 */
import { standingClear } from '../src/shared/collision';
import { GAME_CONFIG } from '../src/shared/constants';
import { COMPOUND } from '../src/shared/mapData';
import { clearLine, findPath } from '../src/shared/navgrid';
import { NpcWorld, type Perceivable } from '../src/shared/npc';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const cfg = GAME_CONFIG.guards;
const DT = 1 / 30;
const RADIUS = GAME_CONFIG.player.radius;

/**
 * Collision resolution parks a body EXACTLY flush against whatever stopped it,
 * and "exactly" lands on either side of a float comparison. Leaning on a wall
 * is what walls are for; the regression worth catching is a body pushed
 * THROUGH one, so allow a hair of overlap and no more.
 */
const FLUSH = 0.05; // m

const centre = (r: (typeof COMPOUND.rooms)[number]) => ({
  x: (r.minX + r.maxX) / 2,
  z: (r.minZ + r.maxZ) / 2,
});

console.log('\n=== every room reaches every other room ===');
{
  let pairs = 0;
  let unreachable = '';
  let offGrid = '';
  for (const a of COMPOUND.rooms) {
    for (const b of COMPOUND.rooms) {
      if (a.id === b.id) continue;
      pairs++;
      const path = findPath(centre(a), centre(b));
      if (!path) {
        unreachable ||= `${a.id} -> ${b.id}`;
        continue;
      }
      // A waypoint you cannot stand on is a waypoint a guard grinds against.
      for (const p of path) {
        if (!standingClear(p.x, p.z, RADIUS, COMPOUND.colliders)) {
          offGrid ||= `${a.id} -> ${b.id} @ (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;
        }
      }
    }
  }
  check(`${pairs} room pairs all routable`, unreachable === '', unreachable);
  check('every waypoint is standable', offGrid === '', offGrid);
}

console.log('\n=== waypoints are reachable from one another in a straight line ===');
{
  // String-pulling is only sound if each leg is walkable on its own. If it is
  // not, a guard who leaves a waypoint early sets off through the wall beside
  // the door he was about to use — which is exactly how the jam looked.
  let broken = '';
  for (const a of COMPOUND.rooms) {
    for (const b of COMPOUND.rooms) {
      if (a.id === b.id) continue;
      const from = centre(a);
      const path = findPath(from, centre(b));
      if (!path) continue;
      let prev = from;
      for (const p of path) {
        if (!clearLine(prev, p)) broken ||= `${a.id} -> ${b.id} leg to (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`;
        prev = p;
      }
    }
  }
  check('every leg of every route is clear', broken === '', broken);
}

/**
 * Fire a shot at (x, z) and let the compound respond. Reports, per guard that
 * actually set off, how close it managed to get — and whether it ever ended a
 * tick standing inside something.
 */
function respondTo(x: number, z: number, seconds: number) {
  const world = new NpcWorld();
  const nobody: Perceivable[] = [];
  let now = 0;

  // Settle a moment first so guards are on their routes, not at spawn.
  for (let t = 0; t < 1; t += DT) {
    now += DT * 1000;
    world.tick(DT, now, nobody, COMPOUND.colliders);
  }

  world.hearNoise(x, z, cfg.gunshotHearRadius);
  const responders = new Set<number>();
  const closest = new Map<number, number>();
  let embedded = '';

  for (let t = 0; t < seconds; t += DT) {
    now += DT * 1000;
    world.tick(DT, now, nobody, COMPOUND.colliders);
    for (const npc of world.snapshots()) {
      if (npc.kind !== 'guard') continue;
      if (npc.mode === 'investigating') responders.add(npc.id);
      if (!responders.has(npc.id)) continue;
      const d = Math.hypot(npc.x - x, npc.z - z);
      closest.set(npc.id, Math.min(closest.get(npc.id) ?? Infinity, d));
      // `standingClear`, not the navgrid: the grid is deliberately conservative
      // at half-metre resolution, so a guard standing perfectly legally in a door
      // jamb sits in a cell whose CENTRE is blocked. The collider test is the truth.
      if (!standingClear(npc.x, npc.z, RADIUS - FLUSH, COMPOUND.colliders)) {
        embedded ||= `guard ${npc.id} at (${npc.x.toFixed(2)}, ${npc.z.toFixed(2)})`;
      }
    }
  }
  return { closest, embedded };
}

console.log('\n=== guards walk to the noise instead of into a wall ===');
{
  // The three cases measured before pathfinding existed. Distances then:
  // Storage 24.6 m short, Security Office 25.1 m, Telegram Room 5.5 m.
  const cases: Array<{ where: string; x: number; z: number }> = [
    { where: 'Storage', x: 10, z: 26 },
    { where: 'Security Office', x: -10, z: 26 },
    { where: 'Telegram Room', x: -10, z: 7 },
  ];

  for (const c of cases) {
    const { closest, embedded } = respondTo(c.x, c.z, 25);
    const arrived = [...closest.values()].filter((d) => d <= cfg.investigateReach).length;
    const best = Math.min(...closest.values());
    check(
      `${c.where} (${c.x}, ${c.z}): someone reaches the noise`,
      arrived > 0,
      `${arrived}/${closest.size} responders within ${cfg.investigateReach} m, closest ${best.toFixed(2)} m`,
    );
    check(`${c.where}: nobody ends a tick inside a collider`, embedded === '', embedded);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
