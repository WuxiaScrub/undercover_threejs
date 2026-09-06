/**
 * Server-authoritative combat (CLAUDE.md §6, §12).
 *
 * The client is trusted with exactly two things: where it fired from and which
 * way it was pointing. Everything after that — what the ray hit, which body part,
 * how much damage that is, and whether it killed anyone — is decided here, using
 * the same shared/combat.ts code the client runs against solo-mode bots.
 *
 * Ammunition and reloading stay on the client for the prototype. The thing worth
 * enforcing is the rate of fire, and that is checked below.
 */
import {
  damageFor,
  meleeDamageFor,
  resolveMelee,
  resolveShot,
  type CombatTarget,
} from '../shared/combat';
import { GAME_CONFIG } from '../shared/constants';
import { round, type ServerMessage } from '../shared/net';
import type { NpcWorld } from '../shared/npc';
import type { Collider } from '../shared/types';
import type { ItemId } from '../shared/inventory';
import { WEAPONS, type WeaponId } from '../shared/weapons';
import type { PlayerState } from './PlayerState';

const cfg = GAME_CONFIG.combat;

export type FireRequest = {
  weapon: WeaponId;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
};

/**
 * What one attack produced. `toAttacker` is private feedback (the hitmarker),
 * `toAll` is what everyone may see (the tracer, a death).
 */
export type CombatOutcome = {
  toAll: ServerMessage[];
  toAttacker: ServerMessage[];
  /** Health updates keyed by the player whose health changed. */
  healthUpdates: { player: PlayerState; byId: number }[];
  /** Kit that a death put on the floor (CLAUDE.md §3 as the user specified it). */
  drops: Drop[];
};

/** Items to spill at a point — a corpse's inventory, or a guard's rifle. */
export type Drop = { items: ItemId[]; x: number; y: number; z: number };

const nothing = (): CombatOutcome => ({
  toAll: [],
  toAttacker: [],
  healthUpdates: [],
  drops: [],
});

export class CombatSystem {
  fire(
    shooter: PlayerState,
    req: FireRequest,
    players: readonly PlayerState[],
    npcs: NpcWorld,
    // Doors are not part of COMPOUND.colliders, so the caller hands us the list
    // that includes leaves for whichever doors are currently shut. A closed door
    // stops a bullet; an open one does not.
    solids: readonly Collider[],
    now: number,
  ): CombatOutcome {
    if (!shooter.alive) return nothing();

    const def = WEAPONS[req.weapon];
    if (!def) return nothing();

    // Rate of fire. Slack absorbs jitter; it cannot turn a rifle into a machine gun.
    if (now - shooter.lastFireMs < def.fireInterval * cfg.fireRateSlack * 1000) return nothing();

    const origin = { x: req.ox, y: req.oy, z: req.oz };
    const length = Math.hypot(req.dx, req.dy, req.dz);
    if (!Number.isFinite(length) || length < 1e-6) return nothing();
    const direction = { x: req.dx / length, y: req.dy / length, z: req.dz / length };

    // The claimed muzzle must be on the player. Without this check a client
    // could fire from around a corner, or from inside somebody's office.
    const drift = Math.hypot(origin.x - shooter.x, origin.y - (shooter.y + 1.0), origin.z - shooter.z);
    if (drift > cfg.maxShotOriginError) return nothing();

    shooter.lastFireMs = now;

    // A shot is the loudest thing that happens in this compound. Patrolling
    // guards head for it — they do not know who fired, only where.
    npcs.hearNoise(shooter.x, shooter.z, GAME_CONFIG.guards.gunshotHearRadius);

    // Guards and the General are shot at through the same resolver as players —
    // one ray, one nearest-wins rule, no special cases.
    const targets: CombatTarget[] = [...players.map((p) => p.target), ...npcs.combatTargets()];
    const outcome = resolveShot(
      origin,
      direction,
      req.weapon,
      targets,
      solids,
      shooter.id,
    );

    const result = nothing();
    result.toAll.push({
      t: 'shot',
      id: shooter.id,
      weapon: req.weapon,
      ox: round(origin.x),
      oy: round(origin.y),
      oz: round(origin.z),
      hx: round(outcome.point.x),
      hy: round(outcome.point.y),
      hz: round(outcome.point.z),
    });

    if (outcome.kind !== 'hit') return result;
    const damage = damageFor(req.weapon, outcome.region);

    const victim = players.find((p) => p.id === outcome.targetId);
    if (victim) {
      const killed = victim.applyDamage(damage, now);
      result.toAttacker.push({ t: 'hitmark', region: outcome.region, lethal: killed });
      result.healthUpdates.push({ player: victim, byId: shooter.id });
      if (killed) {
        result.toAll.push({
          t: 'death',
          id: victim.id,
          byId: shooter.id,
          cause: req.weapon,
          region: outcome.region,
        });
        result.drops.push({
          items: victim.inventoryList,
          x: victim.x,
          y: victim.y,
          z: victim.z,
        });
        victim.inventory.clear();
        victim.visibleWeapon = null;
      }
      return result;
    }

    const npcHit = npcs.applyDamage(outcome.targetId, damage, shooter.id, { x: shooter.x, z: shooter.z });
    if (!npcHit) return result;

    result.toAttacker.push({ t: 'hitmark', region: outcome.region, lethal: npcHit.killed });
    if (npcHit.killed) {
      result.toAll.push({
        t: 'death',
        id: outcome.targetId,
        byId: shooter.id,
        cause: req.weapon,
        region: outcome.region,
      });
      const target = npcs.combatTargets().find((t) => t.id === outcome.targetId);
      // A dead guard drops his issued rifle plus anything he confiscated.
      if (npcHit.kind === 'guard' && target && npcHit.drops.length > 0) {
        result.drops.push({ items: npcHit.drops, x: target.x, y: target.y, z: target.z });
      }
    }
    return result;
  }

  /**
   * Unarmed strike (no hit regions — a punch is a punch). Damage comes from the
   * attacker's role, so an officer brawls far better than a secretary.
   */
  melee(
    attacker: PlayerState,
    dx: number,
    dz: number,
    players: readonly PlayerState[],
    npcs: NpcWorld,
    solids: readonly Collider[],
    now: number,
  ): CombatOutcome {
    if (!attacker.alive) return nothing();
    if (now - attacker.lastMeleeMs < cfg.melee.cooldown * 1000) return nothing();

    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-6) return nothing();

    attacker.lastMeleeMs = now;

    const result = nothing();
    result.toAll.push({ t: 'swing', id: attacker.id });

    const origin = { x: attacker.x, y: attacker.y + 1.2, z: attacker.z };
    const direction = { x: dx / length, y: 0, z: dz / length };
    const hit = resolveMelee(
      origin,
      direction,
      [...players.map((p) => p.target), ...npcs.combatTargets()],
      solids,
      attacker.id,
    );
    if (!hit) return result;

    // A landed punch carries a fraction as far as a gunshot, but it carries.
    npcs.hearNoise(attacker.x, attacker.z, GAME_CONFIG.guards.meleeHearRadius);

    const damage = meleeDamageFor(attacker.role);
    const victim = players.find((p) => p.id === hit.id);
    if (victim) {
      const killed = victim.applyDamage(damage, now);
      result.toAttacker.push({ t: 'hitmark', region: 'melee', lethal: killed });
      result.healthUpdates.push({ player: victim, byId: attacker.id });
      if (killed) {
        result.toAll.push({
          t: 'death',
          id: victim.id,
          byId: attacker.id,
          cause: 'melee',
          region: null,
        });
        result.drops.push({ items: victim.inventoryList, x: victim.x, y: victim.y, z: victim.z });
        victim.inventory.clear();
        victim.visibleWeapon = null;
      } else {
        // Stagger the survivor. Not sent on a kill: the death clip takes over.
        result.toAll.push({ t: 'struck', id: victim.id });
      }
      return result;
    }

    const npcHit = npcs.applyDamage(hit.id, damage, attacker.id, { x: attacker.x, z: attacker.z });
    if (!npcHit) return result;
    result.toAttacker.push({ t: 'hitmark', region: 'melee', lethal: npcHit.killed });
    if (npcHit.killed) {
      result.toAll.push({ t: 'death', id: hit.id, byId: attacker.id, cause: 'melee', region: null });
      if (npcHit.kind === 'guard' && npcHit.drops.length > 0) {
        result.drops.push({ items: npcHit.drops, x: hit.x, y: hit.y, z: hit.z });
      }
    } else {
      // Stagger the surviving NPC and notify clients so the animation plays.
      npcs.stun(hit.id, cfg.melee.stunDuration);
      result.toAll.push({ t: 'struck', id: hit.id });
    }
    return result;
  }

  /** Respawn is refused until the corpse has lain there long enough. */
  canRespawn(player: PlayerState, now: number): boolean {
    return !player.alive && now - player.diedAtMs >= cfg.respawnDelay * 1000;
  }
}
