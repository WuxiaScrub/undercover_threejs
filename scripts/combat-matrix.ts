/**
 * CLAUDE.md §37 combat matrix, run against the SAME shared code the server uses.
 * Prints hits-to-kill for every role x weapon x hit region, then checks cover,
 * melee gating and player-vs-player collision.
 */
import { damageFor, meleeDamageFor, resolveMelee, resolveShot } from '../src/shared/combat';
import { moveBody } from '../src/shared/collision';
import { HITBOXES, type HitRegion } from '../src/shared/hitbox';
import { COMPOUND } from '../src/shared/mapData';
import { ROLE_ORDER, ROLE_STATS } from '../src/shared/roles';
import { canCarry, canConceal, WEAPONS, type WeaponId } from '../src/shared/weapons';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const REGIONS: HitRegion[] = ['head', 'torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg'];
const WEAPONS_LIST: WeaponId[] = ['rifle', 'pistol'];

// Damage is FLAT per weapon x hit class; the differentiator is role health.
// So the invariants worth asserting are about the damage table itself, not
// about hits-to-kill — those follow, and are printed for tuning.
console.log('\n=== damage table ===');
for (const weapon of WEAPONS_LIST) {
  const d = WEAPONS[weapon].damage;
  check(
    `${weapon.padEnd(6)} damage matches its definition`,
    damageFor(weapon, 'head') === d.head &&
      damageFor(weapon, 'torso') === d.torso &&
      damageFor(weapon, 'left_arm') === d.limb &&
      damageFor(weapon, 'right_leg') === d.limb,
    `head ${d.head} torso ${d.torso} limb ${d.limb}`,
  );
}
check(
  'rifle deals exactly twice pistol damage',
  (['head', 'torso', 'limb'] as const).every(
    (k) => WEAPONS.rifle.damage[k] === WEAPONS.pistol.damage[k] * 2,
  ),
);
const toughest = Math.max(...ROLE_ORDER.map((r) => ROLE_STATS[r].maxHealth));
check(
  'a headshot kills every role outright',
  WEAPONS.pistol.damage.head >= toughest,
  `pistol head ${WEAPONS.pistol.damage.head} vs toughest role ${toughest} hp`,
);

console.log('\n=== hits to kill (informational — set by role health) ===');
for (const weapon of WEAPONS_LIST) {
  for (const roleId of ROLE_ORDER) {
    const max = ROLE_STATS[roleId].maxHealth;
    const line = REGIONS.map((region) => {
      const dmg = damageFor(weapon, region);
      return `${region}=${Math.ceil(max / dmg)}`;
    });
    console.log(
      `       ${weapon.padEnd(6)} vs ${ROLE_STATS[roleId].name.padEnd(18)} hp ${String(max).padStart(3)}   ${line.join(' ')}`,
    );
  }
}

// ---------------------------------------------------------------- geometry
console.log('\n=== hit region geometry (ray at each box centre) ===');
const target = { id: 2, x: 0, y: 0, z: -6, yaw: 0, alive: true };
for (const part of HITBOXES) {
  const cy = (part.box.min.y + part.box.max.y) / 2;
  const cx = (part.box.min.x + part.box.max.x) / 2;
  // Fire from due south (+z) straight north at the centre height of the box.
  // The character faces -Z (yaw 0), so its own +X is on our right-hand side.
  const origin = { x: target.x + cx, y: cy, z: target.z + 6 };
  const outcome = resolveShot(origin, { x: 0, y: 0, z: -1 }, 'rifle', [target], [], 1);
  check(
    `aim at ${part.region.padEnd(10)}`,
    outcome.kind === 'hit' && outcome.region === part.region,
    outcome.kind === 'hit' ? `hit ${outcome.region}` : outcome.kind,
  );
}

// ------------------------------------------------------------------- cover
console.log('\n=== cover: a wall between shooter and target ===');
const wall = COMPOUND.colliders.find((c) => c.kind === 'wall')!;
const wallMidX = (wall.min.x + wall.max.x) / 2;
const wallMidZ = (wall.min.z + wall.max.z) / 2;
const spansX = wall.max.x - wall.min.x > wall.max.z - wall.min.z;
// Stand 3 m one side of the wall, target 3 m the other side, shoot straight through.
const off = spansX ? { x: 0, z: 3 } : { x: 3, z: 0 };
const shooter = { x: wallMidX + off.x, y: 1.4, z: wallMidZ + off.z };
const behind = { id: 3, x: wallMidX - off.x, y: 0, z: wallMidZ - off.z, yaw: 0, alive: true };
const len = Math.hypot(behind.x - shooter.x, behind.z - shooter.z);
const dir = { x: (behind.x - shooter.x) / len, y: 0, z: (behind.z - shooter.z) / len };
const blocked = resolveShot(shooter, dir, 'rifle', [behind], COMPOUND.colliders, 1);
check('shot through a wall does not hit the body', blocked.kind !== 'hit', blocked.kind);
const clear = resolveShot(shooter, dir, 'rifle', [behind], [], 1);
check('same shot with no geometry DOES hit', clear.kind === 'hit', clear.kind);

// ------------------------------------------------------------------ melee
console.log('\n=== melee ===');
const me = { x: 0, y: 1.2, z: 0 };
const front = { id: 4, x: 0, y: 0, z: -1.5, yaw: 0, alive: true };
const far = { id: 5, x: 0, y: 0, z: -5, yaw: 0, alive: true };
const behindMe = { id: 6, x: 0, y: 0, z: 1.5, yaw: 0, alive: true };
check('strikes a target 1.5 m ahead', resolveMelee(me, { x: 0, y: 0, z: -1 }, [front], [], 1)?.id === 4);
check('does not reach 5 m', resolveMelee(me, { x: 0, y: 0, z: -1 }, [far], [], 1) === null);
check('does not hit behind you', resolveMelee(me, { x: 0, y: 0, z: -1 }, [behindMe], [], 1) === null);
check('does not hit a corpse', resolveMelee(me, { x: 0, y: 0, z: -1 }, [{ ...front, alive: false }], [], 1) === null);
for (const roleId of ROLE_ORDER) {
  const dmg = meleeDamageFor(roleId);
  const worst = Math.min(...ROLE_ORDER.map((r) => Math.ceil(ROLE_STATS[r].maxHealth / dmg)));
  const best = Math.max(...ROLE_ORDER.map((r) => Math.ceil(ROLE_STATS[r].maxHealth / dmg)));
  console.log(`       ${ROLE_STATS[roleId].name.padEnd(18)} melee ${String(dmg).padStart(2)} → ${worst}–${best} strikes to kill`);
}

// ------------------------------------------------- player-vs-player collision
console.log('\n=== player-vs-player collision ===');
const body = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: -4 },
  radius: 0.35,
  height: 1.8,
  grounded: true,
};
const other = { x: 0, y: 0, z: -0.5, radius: 0.35, height: 1.8 };
const floor = COMPOUND.colliders.filter((c) => c.kind === 'floor');
for (let i = 0; i < 30; i++) moveBody(body, 1 / 60, floor, [other]);
const gap = Math.hypot(body.position.x - other.x, body.position.z - other.z);
check('cannot walk into another body', gap >= 0.69, `separation ${gap.toFixed(3)} m (need ≥ 0.70)`);

const solo = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: -4 },
  radius: 0.35,
  height: 1.8,
  grounded: true,
};
for (let i = 0; i < 30; i++) moveBody(solo, 1 / 60, floor, []);
check('walks freely with nobody there', solo.position.z < -1.5, `travelled ${(-solo.position.z).toFixed(2)} m`);

const overhead = {
  position: { x: 0, y: 3, z: 0 },
  velocity: { x: 0, y: 0, z: -4 },
  radius: 0.35,
  height: 1.8,
  grounded: false,
};
const preZ = overhead.position.z;
moveBody(overhead, 1 / 60, [], [{ x: 0, y: 0, z: -0.5, radius: 0.35, height: 1.8 }]);
check('ignores a body far below', overhead.position.z < preZ);

// ------------------------------------------------------- rifle vs pistol
// CLAUDE.md §11: the rifle is the long, accurate, conspicuous gun and the pistol
// is the short, sloppy, concealable one. Damage is flat and identical in shape,
// so range and cone are the ONLY things that make the trade real — assert them
// behaviourally, through resolveShot, not by reading the table back to itself.
console.log('\n=== rifle reach and accuracy vs the pistol ===');
{
  const pistol = WEAPONS.pistol;
  const rifle = WEAPONS.rifle;

  check(
    'rifle is defined with more reach and a tighter cone',
    rifle.range > pistol.range && rifle.spread < pistol.spread,
    `range ${rifle.range}/${pistol.range} m, spread ${rifle.spread}/${pistol.spread} rad`,
  );
  check(
    'and it costs you speed to carry openly',
    rifle.speedMultiplier < pistol.speedMultiplier,
    `x${rifle.speedMultiplier} vs x${pistol.speedMultiplier}`,
  );
  // The rifle is not gated at pickup — a doctor who finds a dead guard's rifle
  // may take it. The gate is CONCEALMENT: he cannot put it away, so he is
  // visibly armed from the moment he picks it up and every guard who sees him
  // reacts. That is the trade the weapon exists to offer (CLAUDE.md §11, §22).
  check(
    'anyone may pick a rifle up',
    ROLE_ORDER.every((r) => canCarry(r, 'rifle')),
  );
  check(
    'but only the two armed roles can put one away',
    canConceal('security', 'rifle') &&
      canConceal('guard', 'rifle') &&
      !canConceal('doctor', 'rifle') &&
      !canConceal('secretary', 'rifle') &&
      !canConceal('telegram', 'rifle'),
  );
  check(
    'a pistol is something anyone can pocket',
    ROLE_ORDER.every((r) => canCarry(r, 'pistol') && canConceal(r, 'pistol')),
  );

  const torso = HITBOXES.find((h) => h.region === 'torso')!;
  const aimY = (torso.box.min.y + torso.box.max.y) / 2;

  // Down an empty corridor: a man standing halfway between the two ranges.
  const far = { id: 4, x: 0, y: 0, z: -50, yaw: 0, alive: true };
  const eye = { x: 0, y: aimY, z: 0 };
  const north = { x: 0, y: 0, z: -1 };
  const rifleFar = resolveShot(eye, north, 'rifle', [far], [], 1);
  const pistolFar = resolveShot(eye, north, 'pistol', [far], [], 1);
  check(
    `rifle drops a man at ${-far.z} m`,
    rifleFar.kind === 'hit' && rifleFar.region === 'torso',
    rifleFar.kind,
  );
  check(
    'the same shot with a pistol never reaches him',
    pistolFar.kind === 'miss',
    pistolFar.kind,
  );

  // Same target inside pistol range, but fired at the very edge of each weapon's
  // cone — the worst shot the spread allows. The rifle still lands; the pistol
  // throws it wide of a torso.
  const near = { id: 5, x: 0, y: 0, z: -25, yaw: 0, alive: true };
  const edgeShot = (weapon: WeaponId) => {
    const a = WEAPONS[weapon].spread;
    return resolveShot(eye, { x: Math.sin(a), y: 0, z: -Math.cos(a) }, weapon, [near], [], 1);
  };
  const rifleEdge = edgeShot('rifle');
  const pistolEdge = edgeShot('pistol');
  check(
    `rifle's worst shot at ${-near.z} m still hits the body`,
    rifleEdge.kind === 'hit',
    `${rifleEdge.kind} (cone is +-${(25 * Math.tan(rifle.spread)).toFixed(2)} m wide there)`,
  );
  check(
    "the pistol's worst shot at the same range misses entirely",
    pistolEdge.kind !== 'hit',
    `${pistolEdge.kind} (cone is +-${(25 * Math.tan(pistol.spread)).toFixed(2)} m wide there)`,
  );
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
