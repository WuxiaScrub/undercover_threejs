/**
 * Who is in this round — humans and NPCs in ONE list (CLAUDE.md §2, §30).
 *
 * This file exists because of a single design rule: a player must not be able
 * to tell which characters are people. That rule is unenforceable as long as
 * humans get roles and NPCs are scenery, because the population of "things with
 * a Doctor label" would be exactly one. So the roster is built first, as a
 * multiset of roles covering everybody, and only afterwards is it split into
 * the parts humans play and the parts the brain in `npc.ts` plays.
 *
 * Two consequences fall out of that and are load-bearing:
 *
 *   - The four singleton roles always exist exactly once, whether a human took
 *     them or not. If nobody is playing the Doctor, an NPC is, and the ward is
 *     still attended.
 *   - Guards absorb the remainder. Guard is the only role that can appear many
 *     times, which is what makes it the role a human can disappear into.
 *
 * `security` is index 0 forever: he is always human and always a loyalist (see
 * RoundSystem.start), which is the one fixed point players are allowed to know.
 */
import { shuffle } from './rng';
import type { Role } from './roles';

/**
 * NPCs added on top of the humans, by human count. Totals are 8 / 10 / 12 —
 * enough of a crowd that watching everybody is impossible, small enough that
 * the compound still feels populated rather than mobbed.
 */
export const ROSTER_NPCS: Record<number, number> = { 2: 6, 3: 7, 4: 8 };

/**
 * Infiltrators among the humans, by human count. A fixed table rather than a
 * ratio: at these sizes every extra infiltrator changes the game completely, so
 * the split is a design decision per lobby size and not a rounding artefact.
 */
export const ROSTER_INFILTRATORS: Record<number, number> = { 2: 1, 3: 2, 4: 2 };

/** Roles that exist exactly once per round, in the order they are dealt. */
const SINGLETON_ROLES: readonly Role[] = ['security', 'doctor', 'secretary', 'telegram'];

export type Roster = {
  /** One role per human. Index 0 is always `security`. */
  human: Role[];
  /** One role per NPC. */
  npc: Role[];
};

/** Humans supported. Below `min` there is no round; above `max`, no room. */
export const ROSTER_MIN_HUMANS = 2;
export const ROSTER_MAX_HUMANS = 4;

function clampHumans(humans: number): number {
  return Math.min(ROSTER_MAX_HUMANS, Math.max(ROSTER_MIN_HUMANS, humans));
}

/** Total characters in the compound — humans plus NPCs — excluding patients. */
export function rosterSize(humans: number): number {
  const n = clampHumans(humans);
  return n + ROSTER_NPCS[n]!;
}

export function infiltratorsFor(humans: number): number {
  return ROSTER_INFILTRATORS[clampHumans(humans)]!;
}

/**
 * Deal the round's roles.
 *
 * `rand` is injectable so the tests can pin the deal; everything else about the
 * result is deterministic given the shuffle.
 */
export function buildRoster(humans: number, rand: () => number = Math.random): Roster {
  const n = clampHumans(humans);
  const total = rosterSize(n);

  const all: Role[] = [...SINGLETON_ROLES];
  while (all.length < total) all.push('guard');

  // Index 0 (`security`) is held out of the shuffle: he is the one role whose
  // occupant is guaranteed human, so he must land on a human seat every time.
  const tail = shuffle(all.slice(1), rand);

  return {
    human: ['security', ...tail.slice(0, n - 1)],
    npc: tail.slice(n - 1),
  };
}

/**
 * Public labels for a whole roster (CLAUDE.md §30, and the "no usernames" rule).
 *
 * A nametag is the only thing anyone knows about a stranger, so it must carry
 * the role and NOTHING else — no player name, no hint of whether there is a
 * person behind it. Singleton roles read as themselves; guards are numbered so
 * that players can still say "it was guard three" without that number leaking
 * anything about who is who.
 *
 * @param roles one role per character, in whatever order the caller assigns ids.
 * @returns labels parallel to `roles`.
 */
export function labelRoster(roles: readonly Role[], displayName: (r: Role) => string): string[] {
  const counts = new Map<Role, number>();
  for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);

  const seen = new Map<Role, number>();
  return roles.map((r) => {
    const name = displayName(r).toUpperCase();
    if ((counts.get(r) ?? 0) <= 1) return name;
    const nth = (seen.get(r) ?? 0) + 1;
    seen.set(r, nth);
    return `${name} ${nth}`;
  });
}
