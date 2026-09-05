/**
 * Server-side wrapper around the shared guard brain (CLAUDE.md §17–§22).
 *
 * All the actual thinking is in shared/npc.ts so offline solo mode runs exactly
 * the same guards. This file does the two things only the server can do: turn a
 * guard's shot into damage on an authoritative PlayerState, and turn a guard's
 * events into wire messages.
 */
import type { DoorField } from '../shared/doors';
import { round } from '../shared/net';
import { NpcWorld, type Perceivable } from '../shared/npc';
import type { CombatOutcome } from './CombatSystem';
import type { PlayerState } from './PlayerState';

export class GuardSystem {
  readonly world = new NpcWorld();

  /**
   * `doors` is passed whole rather than as a collider list because guards do two
   * different things with it: they are blocked and blinded by a shut door like
   * anyone else, and — unlike anyone else — they push one open when they walk
   * into it, which is what keeps a closed door from cutting the compound in two.
   */
  tick(
    dt: number,
    nowMs: number,
    players: readonly PlayerState[],
    doors: DoorField,
  ): CombatOutcome {
    const out: CombatOutcome = { toAll: [], toAttacker: [], healthUpdates: [], drops: [] };

    const people: Perceivable[] = players.map((p) => p.perceivable);
    const events = this.world.tick(dt, nowMs, people, doors.solids(), doors);

    for (const ev of events) {
      if (ev.t === 'shout') {
        out.toAll.push({
          t: 'shout',
          id: ev.id,
          text: ev.text,
          x: round(ev.x),
          z: round(ev.z),
          cue: ev.cue,
        });
        continue;
      }

      if (ev.t === 'shot') {
        out.toAll.push({
          t: 'shot',
          id: ev.id,
          weapon: ev.weapon,
          ox: round(ev.origin.x),
          oy: round(ev.origin.y),
          oz: round(ev.origin.z),
          hx: round(ev.end.x),
          hy: round(ev.end.y),
          hz: round(ev.end.z),
        });
        continue;
      }

      const victim = players.find((p) => p.id === ev.targetId);
      if (!victim) continue;
      const killed = victim.applyDamage(ev.damage, nowMs);
      out.healthUpdates.push({ player: victim, byId: ev.id });
      if (killed) {
        out.toAll.push({
          t: 'death',
          id: victim.id,
          byId: ev.id,
          cause: 'rifle',
          region: ev.region,
        });
        out.drops.push({ weapons: victim.inventoryList, x: victim.x, y: victim.y, z: victim.z });
        victim.inventory.clear();
        victim.visibleWeapon = null;
      }
    }

    return out;
  }
}
