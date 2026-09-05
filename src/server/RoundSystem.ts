/**
 * The round: hidden factions, a clock, and a winner (CLAUDE.md §25, §43).
 *
 * This is the smallest thing that makes a win condition mean anything. Without
 * a boundary there is nothing to win; without hidden allegiances there is nobody
 * to win it. Everything here is server-only — the client is told the phase, the
 * clock, and its OWN faction, and nothing else until the round is decided.
 *
 * The secrecy is structural rather than defensive: `factions` is a private map
 * in this class, `announce()` is the only thing that reads it during a round,
 * and it builds a separate message per recipient. There is no code path that
 * puts two players' factions in one message before `roundOver`.
 *
 * Death is final while a round runs (`GAME_CONFIG.round.permanentDeath`). That
 * is not a taste decision: "every infiltrator is dead" is unreachable if the
 * dead come back in four seconds, so the loyalists' second win condition
 * requires it. The switch exists so movement and combat can still be playtested
 * in a sandbox.
 */
import { GAME_CONFIG } from '../shared/constants';
import { infiltratorCount, type Faction } from '../shared/factions';
import type { RoundPhase, ServerMessage } from '../shared/net';
import { ROLE_ORDER, type Role } from '../shared/roles';
import type { PlayerState } from './PlayerState';

const cfg = GAME_CONFIG.round;

export type RoundResult = { winner: Faction; reason: string };

export class RoundSystem {
  phase: RoundPhase = 'lobby';
  /** Server-clock ms this phase ends at; 0 in the lobby, which has no clock. */
  endsAtMs = 0;

  private readonly factions = new Map<number, Faction>();
  private result: RoundResult | null = null;

  get running(): boolean {
    return this.phase === 'active';
  }

  factionOf(id: number): Faction | null {
    return this.factions.get(id) ?? null;
  }

  /**
   * Whether a corpse may get back up. In the lobby and after the round this is
   * the ordinary four-second respawn; during a round it is the whole reason the
   * loyalists can win by elimination.
   */
  get respawnAllowed(): boolean {
    return !(this.phase === 'active' && cfg.permanentDeath);
  }

  /**
   * Deal roles and allegiances and start the clock. The caller resets the world
   * — guards, the General, the floor — because this class owns the round and not
   * the compound.
   */
  start(players: readonly PlayerState[], now: number): void {
    this.factions.clear();
    this.result = null;
    this.phase = 'active';
    this.endsAtMs = now + cfg.durationSeconds * 1000;

    const shuffled = [...players].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length; i++) {
      shuffled[i].setRole(dealRole(i, shuffled.length));
    }

    // Deal allegiance on a second, independent shuffle. Dealing both in one pass
    // would tie them together — the officer would always be a loyalist — and the
    // entire game is that you cannot tell from the uniform (CLAUDE.md §2).
    const forFaction = [...players].sort(() => Math.random() - 0.5);
    const spies = infiltratorCount(forFaction.length, cfg.infiltratorsPerPlayers);
    for (let i = 0; i < forFaction.length; i++) {
      this.factions.set(forFaction[i].id, i < spies ? 'infiltrator' : 'loyalist');
    }
  }

  /**
   * Checked every tick, in this order. Order matters: an infiltrator who shoots
   * the General and is shot himself in the same instant still wins, because the
   * General is dead either way and that is the whole point of the job.
   *
   * @returns the result on the tick it is decided, and null on every other tick.
   */
  tick(players: readonly PlayerState[], generalAlive: boolean, now: number): RoundResult | null {
    if (this.phase !== 'active') {
      // The result banner times out back into the lobby on its own.
      if (this.phase === 'over' && now >= this.endsAtMs) {
        this.phase = 'lobby';
        this.endsAtMs = 0;
      }
      return null;
    }

    if (!generalAlive) return this.finish('infiltrator', 'The General is dead.', now);

    const spies = players.filter((p) => this.factions.get(p.id) === 'infiltrator');
    if (spies.length > 0 && spies.every((p) => !p.alive)) {
      return this.finish('loyalist', 'Every infiltrator was eliminated.', now);
    }

    if (now >= this.endsAtMs) {
      return this.finish('loyalist', 'The General survived the day.', now);
    }

    return null;
  }

  /** The end-of-round reveal. Safe only because the round is already decided. */
  reveal(players: readonly PlayerState[]): ServerMessage & { t: 'roundOver' } {
    return {
      t: 'roundOver',
      winner: this.result?.winner ?? 'loyalist',
      reason: this.result?.reason ?? '',
      reveal: players.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        faction: this.factions.get(p.id) ?? 'loyalist',
      })),
    };
  }

  /**
   * The phase message for ONE player. Built per recipient rather than broadcast
   * because of the `you` field: this is the only thing that ever tells somebody
   * their allegiance, and it must not be able to tell them anybody else's.
   */
  announce(id: number, players: number, now: number): ServerMessage {
    const faction = this.factions.get(id);
    return {
      t: 'round',
      phase: this.phase,
      secondsLeft: this.endsAtMs > 0 ? Math.max(0, (this.endsAtMs - now) / 1000) : 0,
      players,
      ...(this.phase === 'active' && faction ? { you: { faction } } : {}),
    };
  }

  private finish(winner: Faction, reason: string, now: number): RoundResult {
    this.phase = 'over';
    this.endsAtMs = now + cfg.intermissionSeconds * 1000;
    this.result = { winner, reason };
    return this.result;
  }
}

/**
 * At most one Security Officer — he is the only armed role and two of them turn
 * every round into a firefight — and the rest spread evenly over the others so a
 * six-player lobby is not four secretaries.
 */
function dealRole(index: number, total: number): Role {
  if (index === 0 && total >= GAME_CONFIG.round.minPlayers) return 'security';
  const rest = ROLE_ORDER.filter((r) => r !== 'security');
  return rest[(index - 1 + rest.length) % rest.length];
}
