import * as THREE from 'three';
import { NPC_STATS, type NpcSnapshot } from '../../shared/npc';
import type { CharacterModelId } from '../player/CharacterAssets';
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

/**
 * The character model an NPC is drawn with. The General and the ward patients
 * are special-cased because their KIND is what you can see about them; everyone
 * else is drawn from their ROLE, which is the whole point — an NPC Doctor and a
 * human Doctor must be the same model in the same clothes, and `guard` is the
 * fallback because that is the population a stranger disappears into.
 */
function modelFor(snap: NpcSnapshot): CharacterModelId {
  if (snap.kind === 'general' || snap.kind === 'patient') return snap.kind;
  return snap.role;
}

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
    this.mesh.setModel(modelFor(snap));
    this.group.add(this.mesh.group);
    this.group.add(this.tag.sprite);

    this.group.position.set(snap.x, snap.y, snap.z);
    this.target.x = snap.x;
    this.target.y = snap.y;
    this.target.z = snap.z;
    this.target.yaw = snap.yaw;
    this.apply(snap);
  }

  apply(snap: NpcSnapshot, searching = false): void {
    this.target.x = snap.x;
    this.target.y = snap.y;
    this.target.z = snap.z;
    this.target.yaw = snap.yaw;
    this.aiming = snap.aiming;

    // Drive weapon visibility from snapshot so dead NPCs drop their weapon model
    // and unarmed orderlies never show a rifle.
    this.mesh.setWeapon(snap.weapon ?? null);

    if (this.dead !== !snap.alive) {
      this.dead = !snap.alive;
      this.mesh.setDead(this.dead);
    }

    // Lying pose for patients.
    if (snap.pose === 'lie' && snap.alive) {
      this.mesh.group.rotation.x = Math.PI / 2;
    } else if (this.mesh.group.rotation.x !== 0) {
      this.mesh.group.rotation.x = 0;
    }

    // Nothing about the guard state machine reaches the tag any more: a man who
    // has just decided to shoot you looks exactly like a man on his rounds, and
    // finding out which is the game (CLAUDE.md §34).
    const note = !snap.alive
      ? 'DEAD'
      : snap.flagged
        ? '*FLAGGED*'
        : searching
          ? 'SEARCHING'
          : '';
    const line = `${snap.label}|${note}`;
    if (line !== this.lastLabel) {
      this.lastLabel = line;
      this.tag.setText(snap.label, note);
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

  /**
   * Feed the whole NPC list; actors are created and removed to match.
   *
   * @param searching ids currently held in a search. It is not a snapshot field
   *   because it is not world state — it is what THIS client has been told, and
   *   only people standing close enough to watch are told at all.
   */
  apply(snaps: readonly NpcSnapshot[], searching?: ReadonlySet<number>): void {
    for (const snap of snaps) {
      let actor = this.actors.get(snap.id);
      if (!actor) {
        actor = new NpcActor(snap);
        this.actors.set(snap.id, actor);
        this.scene.add(actor.group);
      }
      actor.apply(snap, searching?.has(snap.id) ?? false);
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
