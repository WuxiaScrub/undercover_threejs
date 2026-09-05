/**
 * The Security Officer's patrol (CLAUDE.md §15).
 *
 * The rule that actually needs a test is the last section: missing a patrol
 * disables the search ability TEMPORARILY. There must be no sequence of events
 * that leaves an officer permanently unable to search, and "no sequence of
 * events" is not something you can confirm by playing one round.
 *
 * The rest is geometry — a checkpoint you cannot walk to, or one that sits half
 * inside a wall, is a duty that cannot be done.
 */
import { GAME_CONFIG } from '../src/shared/constants';
import { PatrolDuty } from '../src/shared/duty';
import { COMPOUND, PATROL_CHECKPOINTS, insideCheckpoint } from '../src/shared/mapData';
import { findPath, walkable } from '../src/shared/navgrid';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const cfg = GAME_CONFIG.duty;
const DWELL_MS = cfg.patrolDwellSeconds * 1000;
const centre = (i: number) => ({
  x: (PATROL_CHECKPOINTS[i].min.x + PATROL_CHECKPOINTS[i].max.x) / 2,
  z: (PATROL_CHECKPOINTS[i].min.z + PATROL_CHECKPOINTS[i].max.z) / 2,
});

/** A duty that always picks the first eligible checkpoint and no jitter. */
const pinned = () => new PatrolDuty(() => 0);

console.log('=== every checkpoint is a place you can stand, and get to ===');
{
  // The officer starts in his own office; he has to be able to walk to each one.
  const office = { x: -7, z: 26 };
  for (const cp of PATROL_CHECKPOINTS) {
    const room = COMPOUND.rooms.find((r) => r.id === cp.id)!;
    check(
      `${cp.label}: inside ${room.name}`,
      cp.min.x > room.minX && cp.max.x < room.maxX && cp.min.z > room.minZ && cp.max.z < room.maxZ,
    );

    // Sampled rather than checked at the centre, because the centre of a room is
    // exactly where the furniture is — the Telegram Room's desk sits on it. What
    // matters is that most of the box is floor he can stand on and that he can
    // get to it, not that any one point is clear.
    const spots = sample(cp);
    const open = spots.filter((s) => walkable(s.x, s.z));
    check(
      `${cp.label}: mostly floor`,
      open.length >= spots.length * 0.6,
      `${open.length}/${spots.length} clear`,
    );
    // Pathed to the clear spot nearest the middle of the box — where a person
    // told "go and stand in the Medical Ward" would actually head.
    const mid = { x: (cp.min.x + cp.max.x) / 2, z: (cp.min.z + cp.max.z) / 2 };
    const target = open
      .slice()
      .sort((a, b) => Math.hypot(a.x - mid.x, a.z - mid.z) - Math.hypot(b.x - mid.x, b.z - mid.z))[0];
    check(
      `${cp.label}: reachable from the Security Office`,
      Boolean(target) && findPath(office, target) !== null,
      target ? `(${target.x}, ${target.z})` : 'no clear spot at all',
    );
  }

  check(
    "the General's HQ is not a checkpoint",
    !PATROL_CHECKPOINTS.some((cp) => cp.id === 'general_hq'),
    'a patrol that legitimises standing over the General defeats the point',
  );
  check('there is more than one', PATROL_CHECKPOINTS.length >= 2, `${PATROL_CHECKPOINTS.length}`);
}

console.log('\n=== reaching one, and being sent to the next ===');
{
  const duty = pinned();
  duty.start(0);
  const first = duty.checkpoint;
  const at = centre(PATROL_CHECKPOINTS.indexOf(first));

  check('starts with the ability', duty.searchEnabled);
  check('the deadline is two to three minutes out', within(duty.status(0).secondsLeft, 120, 180),
    `${duty.status(0).secondsLeft.toFixed(0)}s`);

  // Standing in the right room, but not long enough yet.
  duty.tick(at.x, at.z, 1000, 1000);
  check('dwell starts counting', duty.status(1000).dwell > 0);
  check('and does not complete early', duty.checkpoint === first);

  // Walk out again: the timer resets, so loitering in the doorway is not a patrol.
  duty.tick(0, 0, 1500, 500);
  check('leaving resets the dwell', duty.status(1500).dwell === 0);
  check('and does not complete it', duty.checkpoint === first);

  // Now stand there properly.
  duty.tick(at.x, at.z, 2000, DWELL_MS + 1);
  check('standing the full dwell completes it', duty.checkpoint !== first,
    `${first.label} -> ${duty.checkpoint.label}`);
  check('the next deadline is fresh', duty.status(2000).secondsLeft > 100);
}

console.log('\n=== the same room is never given twice running ===');
{
  const duty = new PatrolDuty();
  duty.start(0);
  let now = 0;
  let previous = duty.checkpoint;
  let repeats = 0;
  for (let i = 0; i < 200; i++) {
    const at = centre(PATROL_CHECKPOINTS.indexOf(duty.checkpoint));
    now += DWELL_MS + 1;
    duty.tick(at.x, at.z, now, DWELL_MS + 1);
    if (duty.checkpoint === previous) repeats++;
    previous = duty.checkpoint;
  }
  check('200 checkpoints in a row, none repeated', repeats === 0, `${repeats} repeat(s)`);
}

console.log('\n=== missing it disables search TEMPORARILY, never for good ===');
{
  const duty = pinned();
  duty.start(0);
  const missed = duty.checkpoint;
  const late = 400_000; // long past any jittered deadline

  duty.tick(0, 0, late, 1000);
  check('the deadline passing disables search', !duty.searchEnabled);
  check('the clock reads overdue', duty.status(late).secondsLeft < 0);
  check(
    'the checkpoint does NOT roll over — he still owes this one',
    duty.checkpoint === missed,
    missed.label,
  );

  // Being late a second time changes nothing; there is no deeper hole to fall in.
  duty.tick(0, 0, late + 100_000, 1000);
  check('staying away does not make it worse', !duty.searchEnabled);

  // Walking there, however late, gives it straight back.
  const at = centre(PATROL_CHECKPOINTS.indexOf(missed));
  duty.tick(at.x, at.z, late + 200_000, DWELL_MS + 1);
  check('arriving restores the ability (§15)', duty.searchEnabled);
  check('and hands him the next one', duty.checkpoint !== missed, duty.checkpoint.label);

  // And the restored duty behaves like any other: it can lapse and recover again.
  duty.tick(0, 0, late + 700_000, 1000);
  check('it can lapse again', !duty.searchEnabled);
  const next = centre(PATROL_CHECKPOINTS.indexOf(duty.checkpoint));
  duty.tick(next.x, next.z, late + 800_000, DWELL_MS + 1);
  check('and recover again', duty.searchEnabled);
}

console.log('\n=== the box means the room, not the doorway ===');
{
  const cp = PATROL_CHECKPOINTS[0];
  const mid = centre(0);
  check(`${cp.label}: the middle counts`, insideCheckpoint(cp, mid.x, mid.z));
  check(`${cp.label}: a metre outside does not`, !insideCheckpoint(cp, cp.min.x - 1, mid.z));
  check(`${cp.label}: the wall line does not`, !insideCheckpoint(cp, cp.min.x - 0.01, mid.z));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

function within(value: number, lo: number, hi: number): boolean {
  return value >= lo && value <= hi;
}

/** Points on a half-metre grid across a checkpoint box, matching the nav grid. */
function sample(cp: (typeof PATROL_CHECKPOINTS)[number]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let x = cp.min.x; x <= cp.max.x; x += 0.5) {
    for (let z = cp.min.z; z <= cp.max.z; z += 0.5) out.push({ x, z });
  }
  return out;
}
