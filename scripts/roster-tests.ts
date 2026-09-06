/**
 * The roster — the one rule the rest of the design hangs off (CLAUDE.md §2, §30).
 *
 * The rule is "nobody can tell which characters are people". It is not enforced
 * by a check anywhere in the game; it is enforced by the shape of the data, and
 * the shape of the data is what this file tests. Specifically:
 *
 *   - the four singleton roles exist exactly once whether or not a human took
 *     them, so "there is a Doctor" tells you nothing about the lobby;
 *   - guards absorb every remaining seat, so Guard is the role a human can
 *     disappear into;
 *   - labels carry the role and NOTHING else, and are unique so that "guard
 *     three" means one character to everybody.
 *
 * Plus the one fixed point players ARE allowed to know: the Security Officer is
 * always human and always a loyalist.
 */
import { GUARD_POSTS, GUARD_SPAWNS } from '../src/shared/mapData';
import { NET_CONFIG } from '../src/shared/net';
import { PlayerState } from '../src/server/PlayerState';
import { RoundSystem } from '../src/server/RoundSystem';
import { ROLE_STATS, type Role } from '../src/shared/roles';
import {
  ROSTER_INFILTRATORS,
  ROSTER_NPCS,
  buildRoster,
  infiltratorsFor,
  labelRoster,
  rosterSize,
} from '../src/shared/roster';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const SINGLETONS: Role[] = ['security', 'doctor', 'secretary', 'telegram'];
const LOBBY_SIZES = [2, 3, 4];

function countRoles(roles: readonly Role[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of roles) out[r] = (out[r] ?? 0) + 1;
  return out;
}

console.log('=== the roster covers everybody, exactly once ===');
for (const humans of LOBBY_SIZES) {
  // 200 deals: the shuffle is the only source of variation, so anything that
  // depends on luck shows up here rather than in somebody's playtest.
  let badSecurity = 0;
  let badSize = 0;
  let badMultiset = 0;
  for (let trial = 0; trial < 200; trial++) {
    const { human, npc } = buildRoster(humans);
    if (human[0] !== 'security') badSecurity++;
    if (human.length !== humans || human.length + npc.length !== rosterSize(humans)) badSize++;
    const counts = countRoles([...human, ...npc]);
    const singletonsOk = SINGLETONS.every((r) => counts[r] === 1);
    const guardsOk = (counts.guard ?? 0) === rosterSize(humans) - SINGLETONS.length;
    if (!singletonsOk || !guardsOk) badMultiset++;
  }
  check(`${humans}p: the Security Officer is always a human seat`, badSecurity === 0);
  check(
    `${humans}p: ${humans} humans + ${ROSTER_NPCS[humans]} NPCs = ${rosterSize(humans)} characters`,
    badSize === 0,
  );
  check(
    `${humans}p: four singleton roles, ${rosterSize(humans) - 4} guards, every deal`,
    badMultiset === 0,
  );
}

console.log('\n=== a human can hide in the crowd ===');
{
  // The disguise only works if a human can actually draw a role an NPC also
  // holds. With 2 players that means the second human must sometimes be a guard
  // and sometimes be a singleton — if it were fixed, the lobby would know.
  const seen = new Set<Role>();
  for (let trial = 0; trial < 400; trial++) seen.add(buildRoster(2).human[1]!);
  check(
    'the second human is not always the same role',
    seen.size >= 3,
    `saw ${[...seen].sort().join(', ')}`,
  );
  check('and can be a guard, where the crowd is', seen.has('guard'));
}

console.log('\n=== infiltrators are dealt from a table, not a ratio ===');
for (const humans of LOBBY_SIZES) {
  check(
    `${humans} players → ${ROSTER_INFILTRATORS[humans]} infiltrator(s)`,
    infiltratorsFor(humans) === ROSTER_INFILTRATORS[humans],
    `${infiltratorsFor(humans)}`,
  );
}
check('1/2/2 across the supported sizes', [2, 3, 4].map(infiltratorsFor).join() === '1,2,2');

console.log('\n=== labels say the role and nothing else ===');
{
  const { human, npc } = buildRoster(4);
  const all = [...human, ...npc];
  const labels = labelRoster(all, (r) => ROLE_STATS[r].name);

  check('one label per character', labels.length === all.length);
  check('labels are unique', new Set(labels).size === labels.length, labels.join(' | '));
  check(
    'singleton roles are unnumbered',
    labels.filter((l) => !l.startsWith('GUARD')).every((l) => !/\d/.test(l)),
    labels.filter((l) => !l.startsWith('GUARD')).join(' | '),
  );

  const guards = labels.filter((l) => l.startsWith('GUARD')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  check(
    'guards are numbered 1..N with no gaps',
    guards.every((l, i) => l === `GUARD ${i + 1}`),
    guards.join(', '),
  );
  // The whole point: a label must not encode a person.
  check(
    'no label contains anything but a role and a number',
    labels.every((l) => /^[A-Z ]+( \d+)?$/.test(l)),
    labels.join(' | '),
  );
}

console.log('\n=== the deal, as RoundSystem makes it ===');
for (const humans of LOBBY_SIZES) {
  let badOfficerCount = 0;
  let badOfficerFaction = 0;
  let badSpies = 0;
  let badSeats = 0;
  let badLabels = 0;

  for (let trial = 0; trial < 100; trial++) {
    const now = 1_000_000;
    const players = Array.from(
      { length: humans },
      (_, i) => new PlayerState(i + 1, `p${i + 1}`, 'doctor', 0, 0, 0, now),
    );
    const round = new RoundSystem();
    round.start(players, now);

    const officers = players.filter((p) => p.role === 'security');
    if (officers.length !== 1) badOfficerCount++;
    if (officers[0] && round.factionOf(officers[0].id) !== 'loyalist') badOfficerFaction++;

    const spies = players.filter((p) => round.factionOf(p.id) === 'infiltrator');
    if (spies.length !== infiltratorsFor(humans)) badSpies++;

    if (round.npcSeats.length !== ROSTER_NPCS[humans]) badSeats++;
    // No NPC is ever the Security Officer — he is the one seat reserved for a
    // person, because his ability is worthless if an NPC can hold it.
    if (round.npcSeats.some((s) => s.role === 'security')) badSeats++;

    const labels = [...players.map((p) => p.label), ...round.npcSeats.map((s) => s.label)];
    if (new Set(labels).size !== labels.length || labels.some((l) => !l)) badLabels++;
    // A label must never be the name the player typed.
    if (players.some((p) => p.label === p.name)) badLabels++;
  }

  check(`${humans}p: exactly one Security Officer, and he is human`, badOfficerCount === 0);
  check(`${humans}p: the Security Officer is always a loyalist`, badOfficerFaction === 0);
  check(`${humans}p: ${infiltratorsFor(humans)} infiltrator(s) dealt`, badSpies === 0);
  check(`${humans}p: ${ROSTER_NPCS[humans]} NPC seats, none of them security`, badSeats === 0);
  check(`${humans}p: labels unique across humans and NPCs, and never a username`, badLabels === 0);
}

console.log('\n=== human Guards never start in the ring around the General ===');
{
  const hqStops = GUARD_POSTS.filter((p) => p.hq).map((p) => `${p.route[0]!.x},${p.route[0]!.z}`);
  const onHq = GUARD_SPAWNS.filter((s) => hqStops.includes(`${s.x},${s.z}`));
  check('no human Guard spawn is an HQ post', onHq.length === 0, `${onHq.length} on HQ posts`);
  check(
    'there are enough field posts for a full roster of human Guards',
    GUARD_SPAWNS.length >= 3,
    `${GUARD_SPAWNS.length} field posts`,
  );
  check('some posts are flagged HQ at all', hqStops.length > 0, `${hqStops.length} HQ posts`);
}

console.log('\n=== the lobby is the size the roster was built for ===');
check(
  `maxPlayers is ${NET_CONFIG.maxPlayers}`,
  NET_CONFIG.maxPlayers === 4,
  `${NET_CONFIG.maxPlayers}`,
);
check(
  'the roster table covers every size the server will accept',
  Object.keys(ROSTER_NPCS).map(Number).includes(NET_CONFIG.maxPlayers),
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
