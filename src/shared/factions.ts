/**
 * Hidden allegiance (CLAUDE.md §2, §30).
 *
 * This file is deliberately tiny, and the important thing about it is what
 * imports it: `src/server/RoundSystem.ts`, and nothing on the client except the
 * type of the ONE faction a player is told — their own.
 *
 * The secrecy rule is enforced by the shape of the wire protocol, not by a
 * runtime check: `PlayerPublic` and `PlayerSnapshot` have no faction field, so
 * there is no broadcast a faction could be attached to. A player learns their
 * allegiance from the `round` message addressed to them alone, and everybody's
 * allegiance from `roundOver`, which by definition arrives too late to matter.
 */
export type Faction = 'loyalist' | 'infiltrator';

/** For HUD text and the end-of-round reveal. Never shown for another player mid-round. */
export const FACTION_NAME: Record<Faction, string> = {
  loyalist: 'LOYALIST',
  infiltrator: 'INFILTRATOR',
};

// How many infiltrators a lobby gets is no longer a ratio — see
// `infiltratorsFor` in shared/roster.ts, which is a table, because at 2-4
// humans every extra infiltrator changes the game completely.
