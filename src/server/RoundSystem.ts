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
import type { Faction } from '../shared/factions';
import type { RoundPhase, ServerMessage } from '../shared/net';
import { shuffle } from '../shared/rng';
import { ROLE_STATS, type Role } from '../shared/roles';
import { buildRoster, infiltratorsFor, labelRoster } from '../shared/roster';
import type { PlayerState } from './PlayerState';

const cfg = GAME_CONFIG.round;

export type RoundResult = { winner: Faction; reason: string };

/**
 * What the round needs to know about the compound to decide whether it is over.
 * Passed as an object rather than a growing list of booleans because the loss
 * conditions are about to be several and none of them belong to this class.
 */
export type WorldStatus = {
  generalAlive: boolean;
  /** Ward patients who have died, however they died. */
  patientsDead: number;
  /** Why they died, for the reason line. */
  patientCauses: readonly ('neglect' | 'gunfire')[];
};

export class RoundSystem {
  phase: RoundPhase = 'lobby';
  /** Server-clock ms this phase ends at; 0 in the lobby, which has no clock. */
  endsAtMs = 0;

  private readonly factions = new Map<number, Faction>();
  private result: RoundResult | null = null;

  /**
   * The NPC half of this round's roster, already labelled, for
   * `NpcWorld.reset()`. Humans and NPCs are dealt from ONE list, so the compound
   * cannot be populated until the round has decided who the humans are.
   */
  npcSeats: readonly { role: Role; label: string }[] = [];

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

    // ONE roster covers humans and NPCs (shared/roster.ts). Labels are computed
    // across the whole thing before it is split, which is what makes `GUARD 3`
    // mean the same character to everybody while giving no clue whether there is
    // a person behind it.
    const roster = buildRoster(players.length);
    const all = [...roster.human, ...roster.npc];
    const labels = labelRoster(all, (r) => ROLE_STATS[r].name);

    const shuffled = shuffle([...players]);
    for (let i = 0; i < shuffled.length; i++) {
      shuffled[i]!.setRole(roster.human[i]!);
      shuffled[i]!.label = labels[i]!;
      shuffled[i]!.hqAccess = true;
      shuffled[i]!.searchableAtMs = 0;
    }
    this.npcSeats = roster.npc.map((role, i) => ({
      role,
      label: labels[roster.human.length + i]!,
    }));

    // The Security Officer is the ONE fixed point everybody is allowed to know:
    // always human, always a loyalist. Without that his search ability is
    // worthless — an infiltrator officer would simply search nobody — and the
    // report would have no one it could safely leave off its candidate list.
    // Every other role is dealt allegiance blind, so the uniform still tells you
    // nothing (CLAUDE.md §2).
    const officer = shuffled[0];
    if (officer) this.factions.set(officer.id, 'loyalist');

    const rest = shuffle(shuffled.slice(1));
    const spies = Math.min(rest.length, infiltratorsFor(players.length));
    for (let i = 0; i < rest.length; i++) {
      this.factions.set(rest[i]!.id, i < spies ? 'infiltrator' : 'loyalist');
    }
  }

  /** Ids of this round's infiltrators, for the Telegram Operator's report. */
  get infiltratorIds(): number[] {
    return [...this.factions].filter(([, f]) => f === 'infiltrator').map(([id]) => id);
  }

  /**
   * Checked every tick, in this order. Order matters: an infiltrator who shoots
   * the General and is shot himself in the same instant still wins, because the
   * General is dead either way and that is the whole point of the job.
   *
   * @returns the result on the tick it is decided, and null on every other tick.
   */
  tick(players: readonly PlayerState[], world: WorldStatus, now: number): RoundResult | null {
    if (this.phase !== 'active') {
      // The result banner times out back into the lobby on its own.
      if (this.phase === 'over' && now >= this.endsAtMs) {
        this.phase = 'lobby';
        this.endsAtMs = 0;
      }
      return null;
    }

    if (!world.generalAlive) return this.finish('infiltrator', 'The General is dead.', now);

    // The ward is the second thing the compound can lose. A doctor who never
    // treats anybody and an infiltrator who shoots the beds arrive at the same
    // place, which is exactly the ambiguity the role exists to create.
    if (world.patientsDead >= cfg.patientsLostToLose) {
      return this.finish('infiltrator', patientLossReason(world.patientCauses), now);
    }

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
        name: p.label || p.name,
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

/** Names the way the ward was lost, because how it happened is the accusation. */
function patientLossReason(causes: readonly ('neglect' | 'gunfire')[]): string {
  if (causes.length > 0 && causes.every((c) => c === 'neglect')) {
    return 'The patients died untreated in the medical ward.';
  }
  if (causes.length > 0 && causes.every((c) => c === 'gunfire')) {
    return 'The patients were shot in the medical ward.';
  }
  return 'The medical ward was lost.';
}
