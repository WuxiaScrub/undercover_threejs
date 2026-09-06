/**
 * The NPC roster, run for ten simulated minutes with nobody watching.
 *
 * The roster only works if an NPC in a role is BORING in the way a person in
 * that role would be boring (CLAUDE.md §30, §34): the Doctor does ward rounds
 * and fetches supplies, the Secretary carries paper from Signals to the
 * General, the Telegram Operator sits at a console. That baseline is what makes
 * a *human* in the same role suspicious when they deviate from it — so if the
 * NPC Doctor never leaves the ward, a human Doctor going to Storage is not
 * suspicious, it is unprecedented, and the mechanic is gone.
 *
 * Two things are asserted that no amount of watching would reliably catch:
 *
 *   - **every stop is standable.** A waypoint has to be REACHABLE, not merely
 *     on a clear line. A stop inside a crate is a metre from a clear raycast
 *     and infinitely far from `waypointReach`, so the NPC grinds against it
 *     forever while still cheerfully reporting `mode: 'patrol'`. The route
 *     raycast in `guard-tests.ts` runs at chest height and passes straight over
 *     low props, so it cannot see this class of bug. This can.
 *   - **nobody grinds.** The signature is distinctive: a lot of distance
 *     travelled inside a very small box. A posted sentry stands still (fine);
 *     a patrolling guard covers ground (fine); a stuck one walks a marathon
 *     into a desk.
 */
import { GAME_CONFIG } from '../src/shared/constants';
import { DoorField } from '../src/shared/doors';
import { COMPOUND, GUARD_POSTS, ROLE_ROUTINES } from '../src/shared/mapData';
import { NpcWorld, type GuardMode, type NpcSnapshot } from '../src/shared/npc';
import type { Role } from '../src/shared/roles';
import type { Collider, RoomId } from '../src/shared/types';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const DT = 1 / 30;
const RADIUS = GAME_CONFIG.player.radius;

function room(id: RoomId): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const r = COMPOUND.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`no such room: ${id}`);
  return r;
}
function inside(r: ReturnType<typeof room>, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

// ---------------------------------------------------------------------------
// Every stop is somewhere a body actually fits.
// ---------------------------------------------------------------------------

/** Metres of daylight between an NPC standing at (x, z) and the nearest solid. */
function clearance(x: number, z: number, colliders: readonly Collider[]): { m: number; what: string } {
  let worst = Infinity;
  let what = '';
  for (const c of colliders) {
    if (c.kind === 'floor') continue;
    const dx = Math.max(c.min.x - x, 0, x - c.max.x);
    const dz = Math.max(c.min.z - z, 0, z - c.max.z);
    const d = Math.hypot(dx, dz) - RADIUS;
    if (d < worst) {
      worst = d;
      what = c.label ?? '?';
    }
  }
  return { m: worst, what };
}

console.log('=== every stop on every route is one a body fits in ===');
{
  const solids = new DoorField().solids();
  let worstStop = { label: '', m: Infinity, what: '' };

  for (const post of GUARD_POSTS) {
    let bad = '';
    for (const [i, stop] of post.route.entries()) {
      const c = clearance(stop.x, stop.z, solids);
      if (c.m < worstStop.m) worstStop = { label: `${post.label} #${i}`, m: c.m, what: c.what };
      // Negative clearance means the waypoint is INSIDE something. `waypointReach`
      // can then never be satisfied, and the guard walks at it until the round ends.
      if (c.m < 0) bad = `#${i} (${stop.x},${stop.z}) is ${(-c.m).toFixed(2)}m inside ${c.what}`;
    }
    check(`${post.label.padEnd(14)} every waypoint is reachable`, bad === '', bad);
  }

  for (const [role, stops] of Object.entries(ROLE_ROUTINES)) {
    let bad = '';
    for (const [i, stop] of (stops ?? []).entries()) {
      const c = clearance(stop.x, stop.z, solids);
      if (c.m < worstStop.m) worstStop = { label: `${role} #${i}`, m: c.m, what: c.what };
      if (c.m < 0) bad = `#${i} (${stop.x},${stop.z}) is ${(-c.m).toFixed(2)}m inside ${c.what}`;
    }
    check(`${role.padEnd(14)} every routine stop is reachable`, bad === '', bad);
  }

  console.log(
    `       tightest stop: ${worstStop.label} — ${worstStop.m.toFixed(2)}m from ${worstStop.what}`,
  );
}

// ---------------------------------------------------------------------------
// Ten minutes of the compound minding its own business.
// ---------------------------------------------------------------------------

const MINUTES = 10;
const world = new NpcWorld();
world.reset();
const doors = new DoorField();

type Track = {
  role: Role;
  label: string;
  kind: string;
  travelled: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  modes: Set<GuardMode>;
  samples: { x: number; z: number }[];
};
const tracks = new Map<number, Track>();

function record(snap: NpcSnapshot): void {
  const t = tracks.get(snap.id);
  if (!t) {
    tracks.set(snap.id, {
      role: snap.role,
      label: snap.label,
      kind: snap.kind,
      travelled: 0,
      minX: snap.x,
      maxX: snap.x,
      minZ: snap.z,
      maxZ: snap.z,
      modes: new Set([snap.mode]),
      samples: [{ x: snap.x, z: snap.z }],
    });
    return;
  }
  const last = t.samples[t.samples.length - 1]!;
  t.travelled += Math.hypot(snap.x - last.x, snap.z - last.z);
  t.minX = Math.min(t.minX, snap.x);
  t.maxX = Math.max(t.maxX, snap.x);
  t.minZ = Math.min(t.minZ, snap.z);
  t.maxZ = Math.max(t.maxZ, snap.z);
  t.modes.add(snap.mode);
  t.samples.push({ x: snap.x, z: snap.z });
}

let now = 1_000_000;
for (let step = 0; step < MINUTES * 60 / DT; step++) {
  // Nobody is playing: `people` is empty, so anything that happens here is the
  // compound's own routine and not a reaction to a player.
  world.tick(DT, now, [], doors.solids(), doors);
  now += DT * 1000;
  if (step % 15 === 0) for (const snap of world.snapshots()) record(snap);
}

const staff = [...tracks.values()].filter((t) => t.kind === 'staff');
const guards = [...tracks.values()].filter((t) => t.kind === 'guard');

console.log(`\n=== ${MINUTES} minutes later ===`);
check(`${staff.length} staff NPCs and ${guards.length} guards ran`, staff.length === 3 && guards.length >= 4);

console.log('\n=== the Doctor does rounds, then fetches supplies ===');
{
  const doc = staff.find((t) => t.role === 'doctor');
  const ward = room('medical_ward');
  const store = room('storage');
  const inWard = doc?.samples.filter((s) => inside(ward, s.x, s.z)).length ?? 0;
  const inStore = doc?.samples.filter((s) => inside(store, s.x, s.z)).length ?? 0;

  check('there is an NPC Doctor at all', doc !== undefined);
  check('he spends time in the ward', inWard > 0, `${inWard} samples`);
  // The supply run is the whole point: it is the window in which a HUMAN doctor
  // can be out of the ward without it looking odd.
  check('and he leaves it for Storage', inStore > 0, `${inStore} samples`);
  check(
    'the ward is still where he mostly is',
    inWard > inStore,
    `ward ${inWard} vs storage ${inStore}`,
  );
}

console.log('\n=== the Secretary carries paper from Signals to the General ===');
{
  const sec = staff.find((t) => t.role === 'secretary');
  const signals = room('telegram_room');
  const hq = room('general_hq');
  const atSignals = sec?.samples.filter((s) => inside(signals, s.x, s.z)).length ?? 0;
  const atHq = sec?.samples.filter((s) => inside(hq, s.x, s.z)).length ?? 0;

  check('there is an NPC Secretary at all', sec !== undefined);
  check('she visits the telegram room', atSignals > 0, `${atSignals} samples`);
  // She is the only character who routinely walks through the HQ door, which is
  // also the check that `openNear` lets a staff NPC through it.
  check('and reaches the General inside HQ', atHq > 0, `${atHq} samples`);
}

console.log('\n=== the Telegram Operator sits at a console ===');
{
  const op = staff.find((t) => t.role === 'telegram');
  const signals = room('telegram_room');
  const strayed = op?.samples.filter((s) => !inside(signals, s.x, s.z)) ?? [];
  check('there is an NPC Telegram Operator at all', op !== undefined);
  check(
    'he never leaves the telegram room',
    strayed.length === 0,
    strayed.slice(0, 3).map((s) => `(${s.x.toFixed(1)},${s.z.toFixed(1)})`).join(' '),
  );
  // He moves between the three consoles, so he is not a statue either.
  check('but he does move between consoles', (op?.travelled ?? 0) > 2, `${(op?.travelled ?? 0).toFixed(1)} m`);
}

console.log('\n=== staff have no threat brain, by design ===');
{
  const armed = staff.filter((t) => t.modes.has('suspicious') || t.modes.has('hostile'));
  check(
    'no clerk ever becomes suspicious or hostile',
    armed.length === 0,
    armed.map((t) => `${t.label}: ${[...t.modes].join('/')}`).join(' | '),
  );
  check(
    'they only ever patrol their routine',
    staff.every((t) => [...t.modes].every((m) => m === 'patrol')),
    staff.map((t) => `${t.label}=${[...t.modes].join(',')}`).join(' '),
  );
}

console.log('\n=== nobody grinds into a wall for ten minutes ===');
{
  // The signature of a stuck NPC: metres and metres of walking inside a box a
  // metre across. Standing still is fine — several posts are sentries.
  const stuck = [...tracks.values()].filter((t) => {
    const span = Math.max(t.maxX - t.minX, t.maxZ - t.minZ);
    return t.travelled > 5 && span < 1.5;
  });
  check(
    'no NPC walks a marathon inside a one-metre box',
    stuck.length === 0,
    stuck.map((t) => `${t.label}: ${t.travelled.toFixed(1)}m in ${(Math.max(t.maxX - t.minX, t.maxZ - t.minZ)).toFixed(2)}m`).join(' | '),
  );

  // Sentries are meant to stand and circuits are meant to be walked, so the
  // check has to know which is which. Match each guard to the post he started
  // on rather than assuming an order: a guard given a circuit who never leaves
  // his first waypoint is exactly the failure this file exists to catch.
  let wrongPost = '';
  let idle = '';
  for (const t of guards) {
    const start = t.samples[0]!;
    const post = GUARD_POSTS.find(
      (p) => Math.hypot(p.route[0]!.x - start.x, p.route[0]!.z - start.z) < 1.5,
    );
    if (!post) {
      wrongPost = `${t.label} started at (${start.x.toFixed(1)},${start.z.toFixed(1)}), which is no post`;
      continue;
    }
    const span = Math.max(t.maxX - t.minX, t.maxZ - t.minZ);
    if (post.route.length > 1 && span < 3) {
      idle = `${t.label} on ${post.label} never left ${span.toFixed(1)}m`;
    }
  }
  check('every guard started on a real post', wrongPost === '', wrongPost);
  check('and every guard given a circuit walked it', idle === '', idle);

  // And everyone is still inside the compound, which is the cheapest possible
  // check that nothing has been pushed through a wall by the collision solver.
  const escaped = [...tracks.values()].filter(
    (t) =>
      t.minX < COMPOUND.bounds.minX ||
      t.maxX > COMPOUND.bounds.maxX ||
      t.minZ < COMPOUND.bounds.minZ ||
      t.maxZ > COMPOUND.bounds.maxZ,
  );
  check('and nobody has been squeezed through a wall', escaped.length === 0, escaped.map((t) => t.label).join(', '));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
