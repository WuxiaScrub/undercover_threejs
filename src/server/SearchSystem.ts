/**
 * The Security Officer's search (CLAUDE.md §16).
 *
 * This is the prototype's information-asymmetry machine, and every rule in it
 * exists to protect that asymmetry rather than to model frisking somebody:
 *
 *   - It takes time and pins both parties in place, so a search is a public
 *     event that everyone nearby can watch happen.
 *   - Bystanders are told THAT it happened and never WHAT was found. Only the
 *     officer's copy of the `search` message carries an item list, built per
 *     recipient exactly the way `round.you` is.
 *   - The officer is therefore the only person who knows, and he can lie about
 *     it. A Secretary with a concealed pistol who is searched and then cleared
 *     has learned something real about the officer — and that inference, not the
 *     pistol, is the mechanic.
 *
 * Two further consequences of the roster (shared/roster.ts) shape the code:
 *
 *   - **Targets may be NPCs.** Player ids and NPC ids share one field and there
 *     is nothing in the protocol that distinguishes them, because a Security
 *     Officer who could tell from the interface which Guards were people would
 *     defeat the entire disguise.
 *   - The immunity window means he cannot simply search a queue of everybody; he
 *     has to choose, and choosing is what makes it observable behaviour.
 */
import { GAME_CONFIG } from '../shared/constants';
import type { ItemId } from '../shared/inventory';
import type { NpcWorld } from '../shared/npc';
import type { PlayerState } from './PlayerState';

const cfg = GAME_CONFIG.search;

export type ActiveSearch = {
  officer: number;
  target: number;
  /** True when the target is an NPC rather than another player. */
  targetIsNpc: boolean;
  endsAtMs: number;
};

export type SearchRefusal =
  | 'not-security'
  | 'patrol-overdue'
  | 'dead'
  | 'busy'
  | 'out-of-reach'
  | 'no-target'
  | 'immune';

/** Human-readable refusals, for the officer's prompt line and nobody else's. */
export const SEARCH_REFUSAL_TEXT: Record<SearchRefusal, string> = {
  'not-security': 'ONLY SECURITY MAY SEARCH',
  'patrol-overdue': 'PATROL OVERDUE — SEARCH SUSPENDED',
  dead: 'NOT NOW',
  busy: 'ALREADY SEARCHING',
  'out-of-reach': 'TOO FAR AWAY',
  'no-target': 'NOBODY THERE',
  immune: 'ALREADY SEARCHED RECENTLY',
};

export class SearchSystem {
  private active: ActiveSearch | null = null;

  get current(): ActiveSearch | null {
    return this.active;
  }

  /** Whether this id is pinned in place by a search right now. */
  frozen(id: number): boolean {
    return !!this.active && (this.active.officer === id || this.active.target === id);
  }

  /**
   * Begin a search.
   *
   * @param searchEnabled the officer's patrol standing (`PatrolDuty.searchEnabled`).
   *   The patrol is the only thing that can take this ability away, and it gives
   *   it straight back the moment he walks a checkpoint (CLAUDE.md §15).
   * @returns the started search, or the reason it was refused.
   */
  begin(
    officer: PlayerState,
    targetId: number,
    searchEnabled: boolean,
    players: readonly PlayerState[],
    npcs: NpcWorld,
    now: number,
  ): ActiveSearch | SearchRefusal {
    if (officer.role !== 'security') return 'not-security';
    if (!searchEnabled) return 'patrol-overdue';
    if (!officer.alive) return 'dead';
    if (this.active) return 'busy';

    const targetPlayer = players.find((p) => p.id === targetId);
    if (targetPlayer) {
      if (!targetPlayer.alive) return 'dead';
      if (now < targetPlayer.searchableAtMs) return 'immune';
      if (dist(officer, targetPlayer) > cfg.reach) return 'out-of-reach';
      this.active = { officer: officer.id, target: targetId, targetIsNpc: false, endsAtMs: now + cfg.decisionSeconds * 1000 };
      return this.active;
    }

    const pos = npcs.positionOf(targetId);
    if (!pos) return 'no-target';
    if (Math.hypot(officer.x - pos.x, officer.z - pos.z) > cfg.reach) return 'out-of-reach';
    // The existing stun is exactly the right shape: it freezes an NPC in place
    // without changing what he thinks about anybody.
    npcs.stun(targetId, cfg.decisionSeconds);
    this.active = { officer: officer.id, target: targetId, targetIsNpc: true, endsAtMs: now + cfg.decisionSeconds * 1000 };
    return this.active;
  }

  /**
   * What the officer sees in the target's pockets. Never sent to anyone else.
   * A player's whole inventory shows, concealed weapons included — that is the
   * point of the ability (CLAUDE.md §16).
   */
  itemsOf(search: ActiveSearch, players: readonly PlayerState[], npcs: NpcWorld): ItemId[] {
    if (search.targetIsNpc) return npcs.itemsOf(search.target);
    return players.find((p) => p.id === search.target)?.inventoryList ?? [];
  }

  /**
   * Take one item. It goes into the officer's own inventory unless he is already
   * carrying one of that kind, in which case it lands at his feet — which is a
   * real complication for him, because a rifle on the floor of the central hall
   * is a rifle anybody can pick up.
   *
   * @returns 'taken' | 'dropped' when it worked, or null when the target does
   *   not have that item (a stale click, or a second click on the same row).
   */
  confiscate(
    item: ItemId,
    players: readonly PlayerState[],
    npcs: NpcWorld,
  ): 'taken' | 'dropped' | null {
    const search = this.active;
    if (!search) return null;
    const officer = players.find((p) => p.id === search.officer);
    if (!officer) return null;

    if (search.targetIsNpc) {
      if (!npcs.confiscate(search.target, item)) return null;
    } else {
      const target = players.find((p) => p.id === search.target);
      if (!target || !target.inventory.has(item)) return null;
      target.inventory.delete(item);
      if (target.visibleWeapon === item) target.visibleWeapon = null;
    }

    if (officer.inventory.has(item)) return 'dropped';
    officer.inventory.add(item);
    return 'taken';
  }

  /**
   * End the search, whether released early or timed out. The immunity clock
   * starts here, so a target released after one second is protected for just as
   * long as one held for the full fifteen.
   */
  end(players: readonly PlayerState[], now: number): ActiveSearch | null {
    const search = this.active;
    if (!search) return null;
    this.active = null;
    if (!search.targetIsNpc) {
      const target = players.find((p) => p.id === search.target);
      if (target) target.searchableAtMs = now + cfg.immunitySeconds * 1000;
    }
    return search;
  }

  /** Auto-release once the decision window is up. */
  tick(players: readonly PlayerState[], now: number): ActiveSearch | null {
    if (!this.active || now < this.active.endsAtMs) return null;
    return this.end(players, now);
  }

  /** A disconnect or a death on either side has to drop the hold. */
  abort(id: number, players: readonly PlayerState[], now: number): ActiveSearch | null {
    if (!this.frozen(id)) return null;
    return this.end(players, now);
  }

  reset(): void {
    this.active = null;
  }
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
