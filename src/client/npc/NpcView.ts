import * as THREE from 'three';
import { GUARD_WEAPON, NPC_STATS, type NpcSnapshot } from '../../shared/npc';
import { CharacterMesh, localVelocity } from '../player/CharacterMesh';
import { NameTag } from '../ui/NameTag';

/**
 * Guards and the General, drawn from NPC snapshots (CLAUDE.md §17, §25).
 *
 * Poses are eased toward the latest snapshot rather than interpolated through a
 * history buffer the way remote players are. Guards walk at 2 m/s and nothing
 * about them is frame-critical — the server does their shooting — so a simple
 * exponential ease is smooth enough, and it works unchanged in offline solo mode
 * where poses arrive every frame instead of thirty times a second.
 */
const EASE_PER_SECOND = 14;

/** Ceiling on the speed the gait is driven from, in m/s. See NpcActor.update. */
const SPEED_CLAMP = 6;

/** Modes worth telling the player about; 'patrol' is just a guard doing his job. */
const MODE_LABEL: Record<string, string> = {
  investigating: 'LOOKING...',
  suspicious: 'SUSPICIOUS',
  warning: 'WARNING',
  hostile: 'HOSTILE',
};

/**
 * The General reuses the guard modes to move, but they read as nonsense over
 * his head: he is not investigating anything and he is not hostile to anyone —
 * he is a man with no gun deciding whether the pillar is still good enough.
 */
const GENERAL_MODE_LABEL: Record<string, string> = {
  investigating: 'TAKING COVER',
  suspicious: 'ALARMED',
  warning: 'ALARMED',
  hostile: 'FLEEING',
};

class NpcActor {
  readonly group = new THREE.Group();

  private readonly mesh: CharacterMesh;
  private readonly tag = new NameTag();
  private readonly target = { x: 0, y: 0, z: 0, yaw: 0 };
  private lastLabel = '';
  private speed = 0;
  private aiming = false;
  private dead = false;

  constructor(snap: NpcSnapshot) {
    const stats = NPC_STATS[snap.kind];
    this.mesh = new CharacterMesh(stats.color, stats.headColor);
    // `guard` and `general` are folder names under assets/3d/characters/ as
    // much as they are NPC kinds; the General keeps the placeholder until one
    // exists for him, which is fine — he is meant to read as distinct, not good.
    this.mesh.setModel(snap.kind);
    this.group.add(this.mesh.group);
    this.group.add(this.tag.sprite);

    // A guard's rifle is always in his hands: he is authorised, and seeing that
    // he is armed is exactly the information a player needs (CLAUDE.md §22).
    if (snap.kind === 'guard') this.mesh.setWeapon(GUARD_WEAPON);

    this.group.position.set(snap.x, snap.y, snap.z);
    this.target.x = snap.x;
    this.target.y = snap.y;
    this.target.z = snap.z;
    this.target.yaw = snap.yaw;
    this.apply(snap);
  }

  apply(snap: NpcSnapshot): void {
    this.target.x = snap.x;
    this.target.y = snap.y;
    this.target.z = snap.z;
    this.target.yaw = snap.yaw;
    this.aiming = snap.aiming;

    if (this.dead !== !snap.alive) {
      this.dead = !snap.alive;
      this.mesh.setDead(this.dead);
    }

    const general = snap.kind === 'general';
    const base = general ? 'THE GENERAL' : 'GUARD';
    const labels = general ? GENERAL_MODE_LABEL : MODE_LABEL;
    const label = snap.alive ? (labels[snap.mode] ?? '') : 'DEAD';
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.tag.setText(base, label);
    }
  }

  getHit(stunDuration: number): void {
    this.mesh.playGetHit(stunDuration);
  }

  addBlood(): void {
    this.mesh.addBlood();
  }

  update(dt: number): void {
    const t = 1 - Math.exp(-EASE_PER_SECOND * dt);
    const p = this.group.position;
    const dx = this.target.x - p.x;
    const dz = this.target.z - p.z;
    this.speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    // Clamped because the easing spikes the derived speed whenever a snapshot
    // teleports the target; the direction it implies is still the right one, so
    // scale the vector rather than only its length.
    const scale = this.speed > SPEED_CLAMP ? SPEED_CLAMP / this.speed : 1;
    const vx = dt > 0 ? (dx / dt) * scale : 0;
    const vz = dt > 0 ? (dz / dt) * scale : 0;

    p.x += dx * t;
    p.y += (this.target.y - p.y) * t;
    p.z += dz * t;

    const yaw = this.mesh.yaw + shortestAngle(this.mesh.yaw, this.target.yaw) * t;
    this.mesh.setPose(0, 0, 0, yaw);
    // Guards keep the rifle raised only when they mean it; otherwise it hangs.
    // Raised also swaps the whole gait to the rifle clip set, which is chosen
    // from the weapon in hand — so this is all the wiring a guard needs.
    this.mesh.setAiming(this.aiming);
    const local = localVelocity(vx, vz, yaw);
    this.mesh.update(dt, local.forward, local.right, true);
  }

  dispose(): void {
    this.tag.dispose();
    this.group.removeFromParent();
  }
}

export class NpcView {
  private readonly actors = new Map<number, NpcActor>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Feed the whole NPC list; actors are created and removed to match. */
  apply(snaps: readonly NpcSnapshot[]): void {
    for (const snap of snaps) {
      let actor = this.actors.get(snap.id);
      if (!actor) {
        actor = new NpcActor(snap);
        this.actors.set(snap.id, actor);
        this.scene.add(actor.group);
      }
      actor.apply(snap);
    }

    if (this.actors.size === snaps.length) return;
    const live = new Set(snaps.map((s) => s.id));
    for (const [id, actor] of this.actors) {
      if (live.has(id)) continue;
      actor.dispose();
      this.actors.delete(id);
    }
  }

  getHit(id: number, stunDuration: number): void {
    this.actors.get(id)?.getHit(stunDuration);
  }

  addBlood(id: number): void {
    this.actors.get(id)?.addBlood();
  }

  update(dt: number): void {
    for (const actor of this.actors.values()) actor.update(dt);
  }

  clear(): void {
    for (const actor of this.actors.values()) actor.dispose();
    this.actors.clear();
  }
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
