/**
 * The MANDATORY guard test from CLAUDE.md §37, run against the SAME NpcWorld the
 * server ticks and offline solo mode ticks.
 *
 *   Doctor walking normally                 → ignored
 *   Doctor carrying a CONCEALED pistol      → ignored
 *   Doctor brandishing a pistol in view     → warned, then shot
 *   Doctor brandishing it behind a wall     → ignored
 *   Security Officer with rifle / pistol    → ignored
 *
 * The wall case is the one that matters most: it is the whole reason the map has
 * rooms. If a guard can see through a wall, hiding is meaningless and the
 * hidden-weapon mechanic collapses.
 *
 * Also asserts the patrol routes themselves are walkable, since a route with an
 * unreachable waypoint leaves a guard grinding into a desk forever.
 */
import { raycastColliders } from '../src/shared/collision';
import { GAME_CONFIG } from '../src/shared/constants';
import { COMPOUND, GENERAL_POST, GUARD_POSTS } from '../src/shared/mapData';
import { NpcWorld, type GuardMode, type NpcEvent, type Perceivable } from '../src/shared/npc';
import { ROLE_STATS, type Role } from '../src/shared/roles';
import type { WeaponId } from '../src/shared/weapons';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const SUBJECT_ID = 1;
const DT = 1 / 30;

/** Escalation order, so "worst reached" is a single comparable number. */
const RANK: Record<GuardMode, number> = {
  patrol: 0,
  investigating: 1,
  suspicious: 2,
  warning: 3,
  hostile: 4,
};

type Scenario = {
  role: Role;
  /** VISIBLY held. A concealed weapon is simply absent — that is the whole trick. */
  weapon: WeaponId | null;
  x: number;
  z: number;
  /** How long to stand there. Must exceed reactionDelay + warningDuration to reach HOSTILE. */
  seconds: number;
};

type Result = {
  /** Worst mode any guard reached. */
  worst: GuardMode;
  /** Every mode any guard passed through, so "no warning" can be asserted. */
  modes: Set<GuardMode>;
  shouted: boolean;
  shotsAtSubject: number;
  damageTaken: number;
};

function run(s: Scenario): Result {
  const world = new NpcWorld();
  const person: Perceivable = {
    id: SUBJECT_ID,
    x: s.x,
    y: 0,
    z: s.z,
    yaw: 0,
    role: s.role,
    alive: true,
    weapon: s.weapon,
  };

  const result: Result = {
    worst: 'patrol',
    modes: new Set<GuardMode>(),
    shouted: false,
    shotsAtSubject: 0,
    damageTaken: 0,
  };
  let now = 0;

  for (let elapsed = 0; elapsed < s.seconds; elapsed += DT) {
    now += DT * 1000;
    const events: NpcEvent[] = world.tick(DT, now, [person], COMPOUND.colliders);

    for (const ev of events) {
      if (ev.t === 'shout') result.shouted = true;
      else if (ev.t === 'shot') result.shotsAtSubject++;
      else if (ev.t === 'hit' && ev.targetId === SUBJECT_ID) result.damageTaken += ev.damage;
    }
    for (const npc of world.snapshots()) {
      if (npc.kind !== 'guard') continue;
      result.modes.add(npc.mode);
      if (RANK[npc.mode] > RANK[result.worst]) result.worst = npc.mode;
    }
  }
  return result;
}

/**
 * The north corridor, a few metres south of the two sentries posted OUTSIDE the
 * General's door. They can see you plainly, and it is a public corridor: nobody
 * is doing anything wrong by standing here, so what happens next is entirely
 * about what is in your hands.
 */
const IN_VIEW = { x: 0, z: -4.5 };

/**
 * The Admin Office, whose only door opens onto the west corridor at z = -7 —
 * nowhere a guard patrols, and at an angle no guard's sightline passes through.
 */
const BEHIND_WALL = { x: -8, z: -5 };

/** Just outside the General's door: restricted, but only to a warning. */
const HQ_APPROACH = { x: 0, z: -9 };

/** Inside the General's office. Past this line there is no conversation. */
const INSIDE_HQ = { x: 0, z: -15 };

console.log('\n=== line of sight: the wall really is a wall ===');
{
  // Prove the geometry first, so a failure below is unambiguous.
  const eye = { x: 2, y: 1.55, z: -10.2 };
  const to = (p: { x: number; z: number }) => {
    const dx = p.x - eye.x;
    const dy = 1.15 - eye.y;
    const dz = p.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    return raycastColliders(eye, { x: dx / len, y: dy / len, z: dz / len }, len, COMPOUND.colliders);
  };
  check('sentry has clear sight of the in-view spot', to(IN_VIEW) === null);
  check(
    'sentry sight of the behind-wall spot is blocked',
    to(BEHIND_WALL) !== null,
    to(BEHIND_WALL)?.collider.label ?? '',
  );
}

console.log('\n=== §37 guard reactions ===');

const walking = run({ role: 'doctor', weapon: null, x: IN_VIEW.x, z: IN_VIEW.z, seconds: 6 });
check(
  'doctor standing in plain sight, hands empty → ignored',
  walking.worst === 'patrol' && !walking.shouted && walking.shotsAtSubject === 0,
  `worst ${walking.worst}`,
);

// A concealed pistol is not represented as "a pistol that is hidden"; it is the
// absence of a weapon on the wire. There is nothing here for a guard to notice.
const concealed = run({ role: 'doctor', weapon: null, x: IN_VIEW.x, z: IN_VIEW.z, seconds: 6 });
check(
  'doctor carrying a CONCEALED pistol → ignored',
  concealed.worst === 'patrol' && concealed.shotsAtSubject === 0,
  'concealment is an absence, not a flag',
);

// reactionDelay 0.75 → suspicious; at point-blank the guard is already inside
// standoff so he challenges at once; +warningDuration 2.0 → hostile at ~2.75 s;
// +reactionDelay again → first bullet at ~3.5 s. Two seconds is comfortably
// inside the challenge, and the point of the check is that the shout comes
// BEFORE the shot — a player has to get the chance to comply.
const brandishing = run({ role: 'doctor', weapon: 'pistol', x: IN_VIEW.x, z: IN_VIEW.z, seconds: 2 });
check(
  'doctor brandishing a pistol in view → challenged',
  brandishing.worst === 'warning' && brandishing.shouted,
  `worst ${brandishing.worst}, shouted ${brandishing.shouted}`,
);
check(
  'the challenge comes with a grace period, not a bullet',
  brandishing.shotsAtSubject === 0,
  `${brandishing.shotsAtSubject} shots in the first 2 s`,
);

const ignored = run({ role: 'doctor', weapon: 'pistol', x: IN_VIEW.x, z: IN_VIEW.z, seconds: 8 });
check(
  'doctor who keeps brandishing → guard turns hostile and fires',
  ignored.worst === 'hostile' && ignored.shotsAtSubject > 0,
  `worst ${ignored.worst}, ${ignored.shotsAtSubject} shots, ${ignored.damageTaken} dmg`,
);

const hidden = run({
  role: 'doctor',
  weapon: 'pistol',
  x: BEHIND_WALL.x,
  z: BEHIND_WALL.z,
  seconds: 8,
});
check(
  'doctor brandishing the SAME pistol behind a wall → never noticed',
  hidden.worst === 'patrol' && hidden.shotsAtSubject === 0,
  `worst ${hidden.worst}`,
);

for (const weapon of ['rifle', 'pistol'] as const) {
  const officer = run({ role: 'security', weapon, x: IN_VIEW.x, z: IN_VIEW.z, seconds: 8 });
  check(
    `security officer openly carrying a ${weapon} → ignored`,
    officer.worst === 'patrol' && officer.shotsAtSubject === 0,
    `worst ${officer.worst}`,
  );
}

console.log('\n=== compliance: putting it away ends the alert ===');
{
  const world = new NpcWorld();
  const person: Perceivable = {
    id: SUBJECT_ID,
    x: IN_VIEW.x,
    y: 0,
    z: IN_VIEW.z,
    yaw: 0,
    role: 'doctor',
    alive: true,
    weapon: 'pistol',
  };
  let now = 0;
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [person], COMPOUND.colliders);
    }
  };
  const worst = () =>
    world.snapshots().reduce<GuardMode>((acc, n) => (RANK[n.mode] > RANK[acc] ? n.mode : acc), 'patrol');

  step(2.5);
  const challenged = worst();
  person.weapon = null; // complied
  step(2.0);
  check(
    'guard escalates, then stands down when the weapon is put away',
    RANK[challenged] >= RANK.warning && worst() === 'patrol',
    `challenged at ${challenged}, now ${worst()}`,
  );
}

console.log('\n=== shooting a guard: the compound answers, but not instantly ===');
{
  // A security officer openly carrying a rifle is doing nothing wrong — until he
  // shoots a sentry. Then every guard in earshot comes for him. The thing being
  // pinned here is that they still owe him a reaction delay: an earlier version
  // set the hostile mode by hand and left nextShotAt stale, so the whole compound
  // fired on the same frame the shot landed and killed the player outright.
  const world = new NpcWorld();
  const person: Perceivable = {
    id: SUBJECT_ID,
    x: IN_VIEW.x,
    y: 0,
    z: IN_VIEW.z,
    yaw: 0,
    role: 'security',
    alive: true,
    weapon: 'rifle',
  };
  let now = 0;
  let shotsAtSubject = 0;
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      for (const ev of world.tick(DT, now, [person], COMPOUND.colliders)) {
        if (ev.t === 'hit' && ev.targetId === SUBJECT_ID) shotsAtSubject++;
      }
    }
  };

  step(1.0);
  const calmBefore = world.snapshots().every((n) => n.mode === 'patrol');

  const victim = world.snapshots().find((n) => n.kind === 'guard')!;
  const killed = world.applyDamage(victim.id, 9999, SUBJECT_ID);

  const hostileNow = world.snapshots().filter((n) => n.kind === 'guard' && n.mode === 'hostile');
  check(
    'killing a sentry turns the other guards hostile',
    calmBefore && killed?.killed === true && hostileNow.length >= 2,
    `${hostileNow.length} guards hostile`,
  );

  // Just under the reaction delay.
  step(0.6);
  check('nobody fires inside the reaction delay', shotsAtSubject === 0, `${shotsAtSubject} shots in 0.6 s`);

  step(1.5);
  check('and then they open fire', shotsAtSubject > 0, `${shotsAtSubject} shots by 2.1 s`);
}

console.log('\n=== restricted areas: the General is not a target you walk up to ===');
{
  const approaching = run({ role: 'doctor', weapon: null, x: HQ_APPROACH.x, z: HQ_APPROACH.z, seconds: 2 });
  check(
    'doctor walking up to the HQ door, unarmed → challenged, not shot',
    approaching.worst === 'warning' && approaching.shouted && approaching.shotsAtSubject === 0,
    `worst ${approaching.worst}, ${approaching.shotsAtSubject} shots`,
  );

  const persisting = run({ role: 'doctor', weapon: null, x: HQ_APPROACH.x, z: HQ_APPROACH.z, seconds: 8 });
  check(
    'doctor who ignores the challenge and stays → shot',
    persisting.worst === 'hostile' && persisting.shotsAtSubject > 0,
    `${persisting.shotsAtSubject} shots, ${persisting.damageTaken} dmg`,
  );

  for (const role of ['security', 'secretary'] as const) {
    const allowed = run({ role, weapon: null, x: HQ_APPROACH.x, z: HQ_APPROACH.z, seconds: 6 });
    check(
      `${role} at the HQ door, unarmed → ignored`,
      allowed.worst === 'patrol' && allowed.shotsAtSubject === 0,
      `worst ${allowed.worst}`,
    );
  }

  // Inside the office there is no ladder to climb: patrol straight to hostile.
  for (const role of ['doctor', 'telegram', 'security'] as const) {
    const intruder = run({ role, weapon: null, x: INSIDE_HQ.x, z: INSIDE_HQ.z, seconds: 6 });
    check(
      `${role} INSIDE the General's office → shot, with no warning first`,
      intruder.worst === 'hostile' &&
        intruder.shotsAtSubject > 0 &&
        !intruder.modes.has('warning'),
      `worst ${intruder.worst}, ${intruder.shotsAtSubject} shots, warning ${intruder.modes.has('warning')}`,
    );
  }

  const secretary = run({ role: 'secretary', weapon: null, x: INSIDE_HQ.x, z: INSIDE_HQ.z, seconds: 6 });
  check(
    'the SECRETARY inside the office, unarmed → the one person allowed in',
    secretary.worst === 'patrol' && secretary.shotsAtSubject === 0,
    `worst ${secretary.worst}`,
  );

  const armedSecretary = run({
    role: 'secretary',
    weapon: 'pistol',
    x: INSIDE_HQ.x,
    z: INSIDE_HQ.z,
    seconds: 6,
  });
  check(
    'the same secretary with the pistol OUT → shot, no warning',
    armedSecretary.worst === 'hostile' &&
      armedSecretary.shotsAtSubject > 0 &&
      !armedSecretary.modes.has('warning'),
    `worst ${armedSecretary.worst}, ${armedSecretary.shotsAtSubject} shots`,
  );

  // The Security Officer may carry a rifle anywhere in the compound. Not here.
  const armedOfficer = run({
    role: 'security',
    weapon: 'rifle',
    x: INSIDE_HQ.x,
    z: INSIDE_HQ.z,
    seconds: 6,
  });
  check(
    'a Security Officer with his rifle in the office → shot anyway',
    armedOfficer.worst === 'hostile' && armedOfficer.shotsAtSubject > 0,
    `worst ${armedOfficer.worst}, ${armedOfficer.shotsAtSubject} shots`,
  );
}

console.log('\n=== guards remember faces ===');
{
  // Push a doctor all the way to HOSTILE, then let him do everything right:
  // put the pistol away, break line of sight, wait out the alert. He is still
  // the man who was waving a pistol around, and the guard still knows it.
  const world = new NpcWorld();
  const person: Perceivable = {
    id: SUBJECT_ID,
    x: IN_VIEW.x,
    y: 0,
    z: IN_VIEW.z,
    yaw: 0,
    role: 'doctor',
    alive: true,
    weapon: 'pistol',
  };
  let now = 0;
  let shots = 0;
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      for (const ev of world.tick(DT, now, [person], COMPOUND.colliders)) {
        if (ev.t === 'shot') shots++;
      }
    }
  };
  const hostiles = () =>
    world.snapshots().filter((n) => n.kind === 'guard' && n.mode === 'hostile').length;

  step(4);
  const provokedThem = hostiles() > 0;

  // Comply completely and vanish behind a wall for far longer than loseSightAfter.
  person.weapon = null;
  person.x = BEHIND_WALL.x;
  person.z = BEHIND_WALL.z;
  step(12);
  const calmedDown = hostiles() === 0;
  shots = 0;

  // And walk back out, empty-handed, into the same corridor.
  person.x = IN_VIEW.x;
  person.z = IN_VIEW.z;
  step(0.5);
  const rememberedAtOnce = hostiles() > 0;
  step(2.0);

  check(
    'a guard pushed to hostility remembers the face and re-engages on sight',
    provokedThem && calmedDown && rememberedAtOnce,
    `provoked ${provokedThem}, lost him ${calmedDown}, re-engaged ${rememberedAtOnce}`,
  );
  check(
    'and he does not wait for a second offence before firing',
    shots > 0,
    `${shots} shots at an unarmed man he already knows`,
  );

  // Killing him settles it — otherwise one mistake marks a playtester for good.
  world.forget(SUBJECT_ID);
  shots = 0;
  step(3);
  check('being killed clears the grudge', hostiles() === 0 && shots === 0, `${shots} shots after respawn`);
}

console.log('\n=== guards investigate what they hear ===');
{
  const world = new NpcWorld();
  const nobody: Perceivable[] = [];
  let now = 0;
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, nobody, COMPOUND.colliders);
    }
  };

  step(1);
  const calmBefore = world.snapshots().every((n) => n.kind !== 'guard' || n.mode === 'patrol');

  // A shot in the Central Hall, which no guard can see but several can hear.
  const noise = { x: 0, z: 17 };
  world.hearNoise(noise.x, noise.z, GAME_CONFIG.guards.gunshotHearRadius);
  const investigating = world
    .snapshots()
    .filter((n) => n.kind === 'guard' && n.mode === 'investigating');

  const before = world
    .snapshots()
    .filter((n) => investigating.some((i) => i.id === n.id))
    .map((n) => Math.hypot(n.x - noise.x, n.z - noise.z));
  step(3);
  const after = world
    .snapshots()
    .filter((n) => investigating.some((i) => i.id === n.id))
    .map((n) => Math.hypot(n.x - noise.x, n.z - noise.z));

  check(
    'a gunshot sends patrolling guards to look',
    calmBefore && investigating.length > 0,
    `${investigating.length} guards heard it`,
  );
  check(
    'and they actually walk towards it',
    after.every((d, i) => d < before[i] - 1 || d <= GAME_CONFIG.guards.investigateReach),
    before.map((d, i) => `${d.toFixed(1)}→${after[i].toFixed(1)}`).join(' '),
  );

  // Neither the sentries nor the General's own detail may be lured off him by
  // a noise somewhere else — that would make the whole office a doorbell.
  const detail = world.snapshots().filter((n) => n.kind === 'guard' && n.z < -9);
  check(
    "the General's guards do not leave him",
    detail.length >= 4 && detail.every((n) => n.mode === 'patrol'),
    `${detail.length} still on station`,
  );

  step(GAME_CONFIG.guards.investigateTimeout + 2);
  check(
    'and they go back to their rounds afterwards',
    world.snapshots().every((n) => n.kind !== 'guard' || n.mode === 'patrol'),
  );
}

/**
 * Walk the subject north up the corridor and through the office door, instead
 * of teleporting him inside. This is the case the old tests could not see: the
 * corridor's warn zone puts a guard on the SUSPICIOUS → WARNING ladder before
 * the door, and the ladder used to carry across the threshold with him, buying
 * two free seconds inside a room that is posted shoot-on-sight.
 */
function walkIn(role: Role, weapon: WeaponId | null, dwellOutside: number) {
  const world = new NpcWorld();
  const person: Perceivable = {
    id: SUBJECT_ID, x: 0, y: 0, z: -2, yaw: 0, role, alive: true, weapon,
  };

  const speed = ROLE_STATS[role].walkSpeed;
  let now = 0;
  let crossedAt = -1;
  let firstShotAt = -1;
  const shouts: string[] = [];
  const modesInside = new Set<GuardMode>();

  for (let t = 0; t < dwellOutside + 12; t += DT) {
    now += DT * 1000;
    // Hold in the approach zone first, then walk on in and stop at the desk.
    if (t >= dwellOutside && person.z > -16) person.z -= speed * DT;
    if (crossedAt < 0 && person.z <= -12) crossedAt = t;

    for (const ev of world.tick(DT, now, [person], COMPOUND.colliders)) {
      if (ev.t === 'shout') shouts.push(ev.text);
      else if (ev.t === 'shot' && firstShotAt < 0) firstShotAt = t;
    }
    if (person.z <= -12) {
      for (const npc of world.snapshots()) {
        if (npc.kind === 'guard') modesInside.add(npc.mode);
      }
    }
  }
  return { crossedAt, firstShotAt, shouts, modesInside };
}

console.log('\n=== WALKING into the office, not teleporting into it ===');
{
  const straightIn = walkIn('doctor', null, 0);
  check(
    'doctor walks in → shot within 0.6 s of crossing the threshold',
    straightIn.firstShotAt >= 0 && straightIn.firstShotAt - straightIn.crossedAt < 0.6,
    `crossed ${straightIn.crossedAt.toFixed(2)}s, first shot ${straightIn.firstShotAt.toFixed(2)}s`,
  );
  check(
    'no guard is still WARNING him once he is inside',
    !straightIn.modesInside.has('warning') && !straightIn.modesInside.has('suspicious'),
    [...straightIn.modesInside].join(','),
  );
  check(
    'he does get the corridor warning on the way in',
    straightIn.shouts.some((t) => /no entry|away from that door/i.test(t)),
    straightIn.shouts[0] ?? '(silence)',
  );

  // The regression itself: linger until a guard has climbed the ladder, THEN
  // step through the door. The ladder must not come with him.
  const lingered = walkIn('doctor', null, 4);
  check(
    'doctor lingers in the approach, THEN enters → still shot within 0.6 s',
    lingered.firstShotAt >= 0 && lingered.firstShotAt - lingered.crossedAt < 0.6,
    `crossed ${lingered.crossedAt.toFixed(2)}s, first shot ${lingered.firstShotAt.toFixed(2)}s`,
  );

  const secretary = walkIn('secretary', null, 0);
  check(
    'the secretary walks the same route → nothing happens to her at all',
    secretary.firstShotAt < 0 && secretary.shouts.length === 0,
    `${secretary.shouts.length} shouts`,
  );

  const armed = walkIn('secretary', 'pistol', 0);
  check(
    'the same secretary, pistol out → shot',
    armed.firstShotAt >= 0,
    armed.firstShotAt >= 0 ? `at ${armed.firstShotAt.toFixed(2)}s` : 'never',
  );
}

/**
 * The General (CLAUDE.md §25, §26). He has no weapon and never returns fire —
 * what he does is put one of his own pillars between himself and the shooter,
 * so an assassination costs an angle rather than a click.
 */
console.log('\n=== the General does not stand there and take it ===');
{
  const EYE = 1.55;
  const CHEST = 1.15;
  /** Can someone standing at `from` see a body standing at `to`? */
  const seesBody = (from: { x: number; z: number }, to: { x: number; z: number }) => {
    const eye = { x: from.x, y: EYE, z: from.z };
    const dx = to.x - eye.x;
    const dy = CHEST - eye.y;
    const dz = to.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    return raycastColliders(eye, dir, len, COMPOUND.colliders) === null;
  };

  /** Shoot him and watch what he does about it. */
  const attack = (opts: {
    hunt: boolean;
    seconds: number;
    extraHitAt?: number;
    /** Where the shooter stands. Inside the office (z < -12) or out in the approach. */
    from?: { x: number; z: number };
  }) => {
    const world = new NpcWorld();
    const id = world.generalId;
    const at = () => world.snapshots().find((n) => n.id === id)!;
    const start = opts.from ?? { x: 0, z: -12.5 };
    const attacker: Perceivable = {
      id: SUBJECT_ID, x: start.x, y: 0, z: start.z, yaw: Math.PI,
      role: 'doctor', alive: true, weapon: 'pistol',
    };

    let now = 0;
    for (let t = 0; t < 0.5; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [], COMPOUND.colliders);
    }
    world.applyDamage(id, 20, SUBJECT_ID);

    let hiddenAt = -1;
    let leftPost = false;
    for (let t = 0; t < opts.seconds; t += DT) {
      now += DT * 1000;
      const g = at();
      // Hunt him: sprint straight at wherever he has got to.
      if (opts.hunt) {
        const dx = g.x - attacker.x;
        const dz = g.z - attacker.z;
        const d = Math.hypot(dx, dz);
        if (d > 1.2) {
          attacker.x += (dx / d) * ROLE_STATS.doctor.sprintSpeed * DT;
          attacker.z += (dz / d) * ROLE_STATS.doctor.sprintSpeed * DT;
        }
      }
      if (opts.extraHitAt !== undefined && Math.abs(t - opts.extraHitAt) < DT / 2) {
        world.applyDamage(id, 20, SUBJECT_ID);
      }
      world.tick(DT, now, [attacker], COMPOUND.colliders);

      const after = at();
      if (Math.hypot(after.x - GENERAL_POST.x, after.z - GENERAL_POST.z) > 1.5) leftPost = true;
      if (hiddenAt < 0 && !seesBody(attacker, after)) hiddenAt = t;
    }
    return { hiddenAt, leftPost, end: at() };
  };

  // Shot at from the approach corridor, with the gunman still OUTSIDE the
  // office. Cover works against a man in the doorway, so he uses it.
  const shot = attack({ hunt: false, seconds: 6, from: { x: 0, z: -11 } });
  check('shot at from outside → he leaves the desk', shot.leftPost);
  check(
    'shot at from outside → out of the shooter’s sightline within 3 s',
    shot.hiddenAt >= 0 && shot.hiddenAt < 3,
    shot.hiddenAt < 0 ? 'never hid' : `hid at ${shot.hiddenAt.toFixed(2)}s`,
  );
  check('he never raises a weapon', shot.end.aiming === false);
  check(
    'and he is still in his office — he has not run from a man at the door',
    shot.end.z < -12,
    `ended at (${shot.end.x.toFixed(1)}, ${shot.end.z.toFixed(1)})`,
  );

  // The same shot with the gunman THROUGH the door. Playtesting: "he keeps
  // hiding behind the pillar even when the player is in the room". A pillar
  // does nothing about someone who can simply walk round it, so once the threat
  // is inside the office the only move left is out of it.
  const inside = attack({ hunt: false, seconds: 8, from: { x: 0, z: -12.5 } });
  check(
    'threat INSIDE the office → he bolts instead of hiding',
    inside.end.mode === 'hostile' && inside.end.z > -12,
    `mode ${inside.end.mode}, ended at (${inside.end.x.toFixed(1)}, ${inside.end.z.toFixed(1)})`,
  );

  // Chase him onto his own cover and hit him again: hiding has stopped working,
  // so he runs for the door instead of shuffling round a pillar forever.
  const cornered = attack({ hunt: true, seconds: 12, extraHitAt: 5 });
  check(
    'cornered and hit twice → bolts out of the office',
    cornered.end.mode === 'hostile' && cornered.end.z > -12,
    `mode ${cornered.end.mode}, ended at (${cornered.end.x.toFixed(1)}, ${cornered.end.z.toFixed(1)})`,
  );

  // And when it goes quiet, he goes back to work.
  {
    const world = new NpcWorld();
    const id = world.generalId;
    let now = 0;
    for (let t = 0; t < 0.5; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [], COMPOUND.colliders);
    }
    world.hearNoise(0, -13, GAME_CONFIG.guards.gunshotHearRadius);
    for (let t = 0; t < 25; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [], COMPOUND.colliders);
    }
    const g = world.snapshots().find((n) => n.id === id)!;
    const home = Math.hypot(g.x - GENERAL_POST.x, g.z - GENERAL_POST.z);
    check(
      'threat gone → back to his desk',
      g.mode === 'patrol' && home <= GAME_CONFIG.guards.waypointReach,
      `mode ${g.mode}, ${home.toFixed(2)} m from post`,
    );
  }
}

// § General's own perception of an armed intruder (plan §4).
// An armed player walks INTO the office with no guard in line of sight. The
// General should leave patrol on his own. The same player behind a wall should
// not trigger him at all, confirming canSee honours the raycast.
console.log('\n=== General perceives an armed intruder unaided ===');
{
  // Inside the office, in front of his desk — he can see them.
  const INSIDE_OFFICE = { x: 0, z: -16 };
  // Behind the east wall: line-of-sight blocked by the office wall itself.
  const BEHIND_WALL = { x: 20, z: -16 };

  const runGeneralPerception = (pos: { x: number; z: number }, seconds: number) => {
    const world = new NpcWorld();
    const id = world.generalId;
    const intruder: Perceivable = {
      id: SUBJECT_ID, x: pos.x, y: 0, z: pos.z, yaw: 0,
      role: 'doctor', alive: true, weapon: 'pistol',
    };
    let now = 0;
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [intruder], COMPOUND.colliders);
    }
    return world.snapshots().find((n) => n.id === id)!;
  };

  const visibleResult = runGeneralPerception(INSIDE_OFFICE, 2.0);
  check(
    'armed intruder inside office — General leaves patrol',
    visibleResult.mode !== 'patrol',
    `mode ${visibleResult.mode}`,
  );

  const hiddenResult = runGeneralPerception(BEHIND_WALL, 2.0);
  check(
    'same intruder behind a wall — General stays in patrol',
    hiddenResult.mode === 'patrol',
    `mode ${hiddenResult.mode}`,
  );
}

// Playtesting: "guards sometimes get stuck when they hear a gunshot — they seem
// to keep trying to get to the spot by walking through a wall. This happened
// once when they were in a room with one door." Going IN was never the problem:
// `patrol` was, because it drove straight at the next waypoint with no route at
// all, and the waypoint a guard standing in Storage is nearest to is on the far
// side of the Storage wall.
console.log('\n=== a guard who investigates a side room comes back out of it ===');
{
  const world = new NpcWorld();
  let now = 0;
  const tick = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [], COMPOUND.colliders);
    }
  };
  tick(1);

  // Storage, in the south-east corner: one door, and nothing to find when they
  // get there, so every responder has to turn round and walk back out again.
  world.hearNoise(10, 26, GAME_CONFIG.guards.gunshotHearRadius);
  const responders = world
    .snapshots()
    .filter((n) => n.mode === 'investigating')
    .map((n) => n.id);

  // Long enough to walk there, look round, give up, and get clear.
  tick(40);
  const settled = world.snapshots().filter((n) => responders.includes(n.id));
  const wasAt = new Map(settled.map((n) => [n.id, { x: n.x, z: n.z }]));
  tick(6);
  const later = world.snapshots().filter((n) => responders.includes(n.id));

  check(
    'the noise pulls guards into Storage',
    responders.length > 0,
    `${responders.length} responders`,
  );
  check(
    'every one of them is back on patrol afterwards',
    settled.length > 0 && settled.every((n) => n.mode === 'patrol'),
    settled.map((n) => n.mode).join(','),
  );
  // The bug never stopped them being "on patrol" — it stopped them MOVING. A
  // guard pressed into a wall reports patrol mode quite happily, forever.
  const walked = later.map((n) => {
    const was = wasAt.get(n.id)!;
    return Math.hypot(n.x - was.x, n.z - was.z);
  });
  check(
    'and walking a route, not grinding on a wall',
    walked.length > 0 && walked.every((d) => d > 2),
    walked.map((d) => `${d.toFixed(1)} m`).join(' '),
  );
}

// Playtesting: "three of them were all looking in the direction of the General's
// HQ even though I was shooting at them from the opposite direction." Posted men
// ignored noise outright, so nothing ever turned them round — and a guard facing
// the wrong way cannot see the weapon pointed at his back.
console.log('\n=== a posted sentry turns toward a noise without leaving his post ===');
{
  const world = new NpcWorld();
  let now = 0;
  const tick = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      now += DT * 1000;
      world.tick(DT, now, [], COMPOUND.colliders);
    }
  };
  tick(1);

  // The west door sentry: posted at (-2, -10.2), facing SOUTH down the corridor.
  const sentryId = world.snapshots().find((n) => n.kind === 'guard' && n.z > -11 && n.x < 0)!.id;
  const sentry = () => world.snapshots().find((n) => n.id === sentryId)!;
  const post = sentry();

  // A shot behind him, deep inside the HQ office.
  world.hearNoise(-2, -20, GAME_CONFIG.guards.gunshotHearRadius);
  tick(1.5);
  const looking = sentry();
  const moved = Math.hypot(looking.x - post.x, looking.z - post.z);

  check(
    'he turns to face it',
    Math.abs(looking.yaw) < 0.5,
    `yaw ${post.yaw.toFixed(2)} → ${looking.yaw.toFixed(2)} (0 is due north)`,
  );
  check(
    'without taking a single step off his post',
    moved < 0.05 && looking.mode === 'patrol',
    `moved ${moved.toFixed(3)} m, mode ${looking.mode}`,
  );

  tick(GAME_CONFIG.guards.alertLookDuration + 2);
  const back = sentry();
  check(
    'and goes back to watching the door when nothing comes of it',
    Math.abs(back.yaw - post.yaw) < 0.2,
    `yaw ${back.yaw.toFixed(2)}, post ${post.yaw.toFixed(2)}`,
  );
}

console.log('\n=== witness-gated hostility: LOS separates bystanders from grudge-holders ===');
{
  /**
   * Kill some NPC (by id), attributing the kill to SUBJECT_ID at `attackerPos`,
   * and return whether the guard nearest to `guardPos` held a grudge.
   *
   * The victim's body position is wherever the world placed them. What we control
   * is the attacker's position (`from` in applyDamage → provoke), which is all
   * that determines whether a bystander guard witnesses the shot.
   */
  function killAndObserve(
    victimId: number,
    attackerPos: { x: number; z: number },
    guardPos: { x: number; z: number },
    world: NpcWorld,
    _nowMs: number,
  ) {
    const guard = world.snapshots()
      .filter((n) => n.kind === 'guard' && n.id !== victimId)
      .sort((a, b) =>
        Math.hypot(a.x - guardPos.x, a.z - guardPos.z) -
        Math.hypot(b.x - guardPos.x, b.z - guardPos.z)
      )[0]!;

    world.applyDamage(victimId, 9999, SUBJECT_ID, attackerPos);
    // Check mode immediately after applyDamage (before next tick reacts to perceivables).
    const guardImmediately = world.snapshots().find((n) => n.id === guard.id)!;
    const grudge = world.holdsGrudge(guard.id, SUBJECT_ID);
    return { grudge, mode: guardImmediately.mode, guardId: guard.id };
  }

  // (i) Kill a guard deep inside Admin Office. Attacker at {-17, -5} (inside room).
  // The bystander guard in the west corridor can't see through the inner wall.
  {
    const world = new NpcWorld();
    let now = 1000;
    world.tick(DT, now, [], COMPOUND.colliders);

    // Victim: the guard nearest to the Admin Office position.
    const victim = world.snapshots()
      .filter((n) => n.kind === 'guard')
      .sort((a, b) =>
        Math.hypot(a.x - (-17), a.z - (-5)) -
        Math.hypot(b.x - (-17), b.z - (-5))
      )[0]!;

    const r = killAndObserve(victim.id, { x: -17, z: -5 }, { x: -6, z: 0 }, world, now);
    check(
      '(i) kill attributed to attacker behind a wall — bystander guard has no grudge',
      !r.grudge,
      `grudge=${r.grudge} mode=${r.mode}`,
    );
    check(
      '(i) that guard investigates (heard the kill) but is not immediately hostile',
      r.mode !== 'hostile',
      `mode=${r.mode}`,
    );
  }

  // (ii) Kill in clear line of sight — attacker at {0, -4} in the open north corridor.
  // The chokepoint guard at {2, -10} has clear sight down the corridor.
  {
    const world = new NpcWorld();
    let now = 1000;
    world.tick(DT, now, [], COMPOUND.colliders);

    // Victim: any guard that is not the chokepoint sentry.
    const chokeGuard = world.snapshots()
      .filter((n) => n.kind === 'guard')
      .sort((a, b) =>
        Math.hypot(a.x - 2, a.z - (-10)) -
        Math.hypot(b.x - 2, b.z - (-10))
      )[0]!;

    // Victim must not be the chokepoint guard itself — pick another guard.
    const victim = world.snapshots()
      .filter((n) => n.kind === 'guard' && n.id !== chokeGuard.id)[0]!;

    const r = killAndObserve(victim.id, { x: 0, z: -4 }, { x: 2, z: -10 }, world, now);
    check(
      '(ii) kill in open corridor — chokepoint guard holds the grudge',
      r.grudge,
      `grudge=${r.grudge} mode=${r.mode}`,
    );
    check(
      '(ii) and goes hostile',
      r.mode === 'hostile',
      `mode=${r.mode}`,
    );
  }

  // (iii) The victim NPC itself goes hostile regardless of LOS (first-hand knowledge).
  {
    const world = new NpcWorld();
    let now = 1000;
    world.tick(DT, now, [], COMPOUND.colliders);

    // Pick a guard far from the chokepoint so it hasn't already been provoked.
    const guard = world.snapshots().find(
      (n) => n.kind === 'guard' && Math.hypot(n.x - 0, n.z - (-10)) > 5,
    )!;
    // Shoot but not kill, so we can check the guard's live mode immediately.
    world.applyDamage(guard.id, 10, SUBJECT_ID, { x: -20, z: 0 }); // attacker behind a wall
    // Check immediately after applyDamage — applyDamage sets mode to hostile directly.
    const after = world.snapshots().find((n) => n.id === guard.id)!;
    check(
      '(iii) a guard that was shot goes hostile regardless of attacker LOS',
      after.mode === 'hostile' && world.holdsGrudge(guard.id, SUBJECT_ID),
      `mode=${after.mode} grudge=${world.holdsGrudge(guard.id, SUBJECT_ID)}`,
    );
  }
}

console.log('\n=== guard role: HQ approach allowed, interior shoot-on-sight ===');
{
  // A player Guard standing in the approach zone (just outside the door) should
  // not trigger any violation — 'guard' was added to hq_approach.allow for this.
  const guardAtApproach = run({ role: 'guard', weapon: null, x: 0, z: -8, seconds: 6 });
  check(
    'player Guard at approach (z=-8) → no warning, no shots',
    guardAtApproach.worst === 'patrol' && guardAtApproach.shotsAtSubject === 0,
    `worst=${guardAtApproach.worst} shots=${guardAtApproach.shotsAtSubject}`,
  );

  // But stepping inside the General's office is still forbidden.
  const guardInsideHq = run({ role: 'guard', weapon: null, x: 0, z: -15, seconds: 6 });
  check(
    'player Guard INSIDE the HQ (z=-15) → shot, no warning',
    guardInsideHq.worst === 'hostile' &&
      guardInsideHq.shotsAtSubject > 0 &&
      !guardInsideHq.modes.has('warning'),
    `worst=${guardInsideHq.worst} shots=${guardInsideHq.shotsAtSubject}`,
  );
}

console.log('\n=== patrol routes are walkable ===');
for (const post of GUARD_POSTS) {
  if (post.route.length < 2) continue;
  let blocked = '';
  for (let i = 0; i < post.route.length; i++) {
    const a = post.route[i];
    const b = post.route[(i + 1) % post.route.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    // Waist height: what a guard's body has to fit past, not what he can see over.
    const hit = raycastColliders(
      { x: a.x, y: 1.0, z: a.z },
      { x: dx / len, y: 0, z: dz / len },
      len,
      COMPOUND.colliders,
    );
    if (hit) blocked = `${i}→${(i + 1) % post.route.length} on ${hit.collider.label ?? '?'}`;
  }
  check(`${post.label.padEnd(14)} route is clear`, blocked === '', blocked);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
