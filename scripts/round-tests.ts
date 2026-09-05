/**
 * The round, checked where it actually decides something (CLAUDE.md §37, §43).
 *
 * Three win conditions and one secrecy rule. The secrecy rule is the one worth
 * having a test for at all: everything else here would be caught by playing the
 * game once, but "the wire never carries somebody else's allegiance" is exactly
 * the kind of thing that stays true right up until a convenience broadcast is
 * added six months later, and is invisible when it stops being true.
 */
import { infiltratorCount } from '../src/shared/factions';
import { GAME_CONFIG } from '../src/shared/constants';
import { PlayerState } from '../src/server/PlayerState';
import { RoundSystem } from '../src/server/RoundSystem';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const cfg = GAME_CONFIG.round;

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
  check('4 players get 1 infiltrator', infiltratorCount(4, cfg.infiltratorsPerPlayers) === 1);
  check('6 players get 2 infiltrators', infiltratorCount(6, cfg.infiltratorsPerPlayers) === 2);
  // A round nobody can lose is not a round.
  check('even 1 player gets an infiltrator', infiltratorCount(1, cfg.infiltratorsPerPlayers) === 1);

  const { round, players } = started(6);
  const spies = players.filter((p) => round.factionOf(p.id) === 'infiltrator');
  check('a 6-player round deals exactly 2', spies.length === 2, `dealt ${spies.length}`);

  const officers = players.filter((p) => p.role === 'security');
  check('at most one Security Officer', officers.length === 1, `${officers.length} officers`);

  const roles = new Set(players.map((p) => p.role));
  check('roles are spread, not all the same', roles.size >= 3, `${roles.size} distinct roles`);
}

console.log('\n=== the three win conditions ===');
{
  const { round, players, t0 } = started(6);
  const dead = round.tick(players, false, t0 + 1000);
  check(
    'a dead General is an infiltrator win',
    dead?.winner === 'infiltrator',
    dead ? dead.reason : 'NO RESULT',
  );
}
{
  const { round, players, t0 } = started(6);
  for (const p of players) if (round.factionOf(p.id) === 'infiltrator') p.alive = false;
  const done = round.tick(players, true, t0 + 1000);
  check(
    'the last infiltrator down is a loyalist win',
    done?.winner === 'loyalist',
    done ? done.reason : 'NO RESULT',
  );
}
{
  const { round, players, t0 } = started(6);
  // One infiltrator still standing: the loyalists have not won yet.
  const spies = players.filter((p) => round.factionOf(p.id) === 'infiltrator');
  spies[0].alive = false;
  check(
    'one infiltrator left is not a win',
    round.tick(players, true, t0 + 1000) === null,
    `${spies.filter((p) => p.alive).length} still alive`,
  );

  const expired = round.tick(players, true, t0 + cfg.durationSeconds * 1000);
  check(
    'the clock running out is a loyalist win',
    expired?.winner === 'loyalist',
    expired ? expired.reason : 'NO RESULT',
  );
}
{
  // Ordering: the assassin who dies in the same instant still did the job.
  const { round, players, t0 } = started(6);
  for (const p of players) p.alive = false;
  const both = round.tick(players, false, t0 + 1000);
  check(
    'General dead beats all-infiltrators-dead',
    both?.winner === 'infiltrator',
    both ? both.reason : 'NO RESULT',
  );
}

console.log('\n=== death is final while a round runs ===');
{
  const round = new RoundSystem();
  check('the lobby respawns you', round.respawnAllowed);

  const { round: live } = started(6);
  check(
    'a running round does not',
    live.respawnAllowed === !cfg.permanentDeath,
    `permanentDeath=${cfg.permanentDeath}`,
  );

  live.tick(lobby(0), false, Date.now()); // General down; round over
  check('the result screen respawns you again', live.respawnAllowed);
}

console.log('\n=== nobody learns anybody else\'s allegiance ===');
{
  const { round, players, t0 } = started(6);

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
