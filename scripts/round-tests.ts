/**
 * The round, checked where it actually decides something (CLAUDE.md §37, §43).
 *
 * Four win conditions and one secrecy rule. The secrecy rule is the one worth
 * having a test for at all: everything else here would be caught by playing the
 * game once, but "the wire never carries somebody else's allegiance" is exactly
 * the kind of thing that stays true right up until a convenience broadcast is
 * added six months later, and is invisible when it stops being true.
 *
 * Who gets which role and how many infiltrators are dealt is roster business
 * and lives in `roster-tests.ts`; this file is about what ends a round.
 */
import { GAME_CONFIG } from '../src/shared/constants';
import { PlayerState } from '../src/server/PlayerState';
import { RoundSystem, type WorldStatus } from '../src/server/RoundSystem';
import { infiltratorsFor } from '../src/shared/roster';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const cfg = GAME_CONFIG.round;

/** The compound as the round sees it: nothing wrong anywhere. */
function calm(over: Partial<WorldStatus> = {}): WorldStatus {
  return { generalAlive: true, patientsDead: 0, patientCauses: [], ...over };
}

function lobby(n: number): PlayerState[] {
  const now = Date.now();
  return Array.from(
    { length: n },
    (_, i) => new PlayerState(i + 1, `p${i + 1}`, 'doctor', 0, 0, 0, now),
  );
}

function started(n: number): { round: RoundSystem; players: PlayerState[]; t0: number } {
  const players = lobby(n);
  const round = new RoundSystem();
  const t0 = 1_000_000;
  round.start(players, t0);
  return { round, players, t0 };
}

console.log('=== the deal ===');
{
  const { round, players } = started(4);
  const spies = players.filter((p) => round.factionOf(p.id) === 'infiltrator');
  check(
    'a 4-player round deals the table count',
    spies.length === infiltratorsFor(4),
    `dealt ${spies.length}, table says ${infiltratorsFor(4)}`,
  );
  check(
    'every player is dealt an allegiance',
    players.every((p) => round.factionOf(p.id) !== null),
  );
  check(
    'the infiltrator ids are exactly those players',
    round.infiltratorIds.sort().join() === spies.map((p) => p.id).sort().join(),
    round.infiltratorIds.join(),
  );
  // Nobody can win a round with no opposition in it.
  check('a 2-player round still has an infiltrator', started(2).round.infiltratorIds.length === 1);
}

console.log('\n=== the four win conditions ===');
{
  const { round, players, t0 } = started(4);
  const dead = round.tick(players, calm({ generalAlive: false }), t0 + 1000);
  check(
    'a dead General is an infiltrator win',
    dead?.winner === 'infiltrator',
    dead ? dead.reason : 'NO RESULT',
  );
}
{
  const { round, players, t0 } = started(4);
  for (const p of players) if (round.factionOf(p.id) === 'infiltrator') p.alive = false;
  const done = round.tick(players, calm(), t0 + 1000);
  check(
    'the last infiltrator down is a loyalist win',
    done?.winner === 'loyalist',
    done ? done.reason : 'NO RESULT',
  );
}
{
  const { round, players, t0 } = started(4);
  // One infiltrator still standing: the loyalists have not won yet.
  const spies = players.filter((p) => round.factionOf(p.id) === 'infiltrator');
  spies[0]!.alive = false;
  check(
    'one infiltrator left is not a win',
    round.tick(players, calm(), t0 + 1000) === null,
    `${spies.filter((p) => p.alive).length} still alive`,
  );

  const expired = round.tick(players, calm(), t0 + cfg.durationSeconds * 1000);
  check(
    'the clock running out is a loyalist win',
    expired?.winner === 'loyalist',
    expired ? expired.reason : 'NO RESULT',
  );
}

console.log('\n=== the ward is the second thing you can lose ===');
{
  const { round, players, t0 } = started(4);
  const one = round.tick(players, calm({ patientsDead: 1, patientCauses: ['neglect'] }), t0 + 1000);
  check('one dead patient is not a loss', one === null, one ? one.reason : '');

  const lost = round.tick(
    players,
    calm({ patientsDead: cfg.patientsLostToLose, patientCauses: ['neglect', 'neglect'] }),
    t0 + 2000,
  );
  check(
    'losing the ward is an infiltrator win',
    lost?.winner === 'infiltrator',
    lost ? lost.reason : 'NO RESULT',
  );
  check(
    'and the reason names neglect, which points at the Doctor',
    (lost?.reason ?? '').toLowerCase().includes('untreated'),
    lost?.reason ?? '',
  );
}
{
  const { round, players, t0 } = started(4);
  const shot = round.tick(
    players,
    calm({ patientsDead: 2, patientCauses: ['gunfire', 'gunfire'] }),
    t0 + 1000,
  );
  check(
    'shot patients read differently — that difference is the accusation',
    (shot?.reason ?? '').toLowerCase().includes('shot'),
    shot?.reason ?? '',
  );
}
{
  const { round, players, t0 } = started(4);
  const mixed = round.tick(
    players,
    calm({ patientsDead: 2, patientCauses: ['neglect', 'gunfire'] }),
    t0 + 1000,
  );
  check(
    'one of each says only that the ward was lost',
    mixed?.winner === 'infiltrator' && !/untreated|shot/i.test(mixed.reason),
    mixed?.reason ?? 'NO RESULT',
  );
}

console.log('\n=== the order of the checks is load-bearing ===');
{
  // The assassin who dies in the same instant still did the job.
  const { round, players, t0 } = started(4);
  for (const p of players) p.alive = false;
  const both = round.tick(players, calm({ generalAlive: false }), t0 + 1000);
  check(
    'General dead beats all-infiltrators-dead',
    both?.winner === 'infiltrator',
    both ? both.reason : 'NO RESULT',
  );
}
{
  // And beats the ward, which is the lesser of the two catastrophes.
  const { round, players, t0 } = started(4);
  const both = round.tick(
    players,
    calm({ generalAlive: false, patientsDead: 2, patientCauses: ['neglect', 'neglect'] }),
    t0 + 1000,
  );
  check(
    'General dead beats the ward',
    both?.reason === 'The General is dead.',
    both ? both.reason : 'NO RESULT',
  );
}

console.log('\n=== death is final while a round runs ===');
{
  const round = new RoundSystem();
  check('the lobby respawns you', round.respawnAllowed);

  const { round: live } = started(4);
  check(
    'a running round does not',
    live.respawnAllowed === !cfg.permanentDeath,
    `permanentDeath=${cfg.permanentDeath}`,
  );

  live.tick(lobby(0), calm({ generalAlive: false }), Date.now()); // round over
  check('the result screen respawns you again', live.respawnAllowed);
}

console.log("\n=== nobody learns anybody else's allegiance ===");
{
  const { round, players, t0 } = started(4);

  // Every player's round message, checked against every OTHER player's faction.
  let leaks = 0;
  for (const p of players) {
    const msg = round.announce(p.id, players.length, t0);
    const json = JSON.stringify(msg);
    const own = round.factionOf(p.id);
    check(
      `#${p.id} is told their own allegiance`,
      msg.t === 'round' && msg.you?.faction === own,
      `${own}`,
    );
    // One faction word, once: their own. Two would mean somebody else's is in there.
    const mentions = (json.match(/loyalist|infiltrator/g) ?? []).length;
    if (mentions !== 1) leaks++;
  }
  check('no round message names a second faction', leaks === 0, `${leaks} message(s) with extras`);

  // And the lobby tells nobody anything at all.
  const idle = new RoundSystem();
  const quiet = idle.announce(1, 1, t0);
  check(
    'the lobby carries no faction at all',
    !JSON.stringify(quiet).includes('faction'),
    JSON.stringify(quiet),
  );
}

console.log('\n=== no player name ever leaves the server ===');
{
  const { round, players } = started(4);
  const reveal = round.reveal(players);
  check(
    'even the end-of-round reveal names roster labels, not usernames',
    reveal.reveal.every((r) => r.name !== '' && !players.some((p) => p.name === r.name)),
    reveal.reveal.map((r) => r.name).join(' | '),
  );
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
