import * as THREE from 'three';
import type { CombatTarget } from '../../shared/combat';
import type { PlayerPublic, PlayerSnapshot } from '../../shared/net';
import { ROLE_STATS, type Role } from '../../shared/roles';
import type { WeaponId } from '../../shared/weapons';
import { NameTag } from '../ui/NameTag';
import { CharacterMesh, localVelocity } from './CharacterMesh';

type Sample = {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  grounded: boolean;
};

/** Samples older than this behind the render clock are of no further use. */
const HISTORY_MS = 1000;
const MAX_SAMPLES = 40;

/**
 * Another player, drawn from interpolated snapshots.
 *
 * Rendering happens deliberately in the past (NET_CONFIG.interpolationDelayMs)
 * so there are always two snapshots to blend between. That trades a fraction of
 * a second of latency for motion with no stutter — the right trade here, because
 * nothing yet depends on frame-exact remote positions. When shooting arrives in
 * milestone 3 the server does its own hit detection against its own positions,
 * so this delay never decides whether a shot lands.
 */
export class RemotePlayer {
  readonly group = new THREE.Group();

  private readonly mesh = new CharacterMesh();
  private readonly tag = new NameTag();
  private readonly samples: Sample[] = [];
  private grounded = true;
  private weapon: WeaponId | null = null;

  /** Server-owned; the client is only told alive/dead, never a number. */
  private _alive = true;
  get alive(): boolean { return this._alive; }
  /** Denounced by a telegraph broadcast. Permanent for the rest of the round. */
  private flagged = false;
  /** Standing still in a Security Officer's search right now. */
  private searching = false;
  private lastNote = '\u0000';
  /** Last interpolated pose, reused for collision and local hit prediction. */
  readonly pose = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(public info: PlayerPublic) {
    this.group.add(this.mesh.group);
    this.group.add(this.tag.sprite);
    this.applyInfo();
  }

  setRole(role: Role): void {
    this.info = { ...this.info, role };
    this.applyInfo();
  }

  private applyInfo(): void {
    const stats = ROLE_STATS[this.info.role];
    this.mesh.setBodyColor(stats.bodyColor);
    this.mesh.setModel(this.info.role);
    this.lastNote = '\u0000';
    this.refreshTag();
  }

  /**
   * The tag is the ROLE and nothing else — no username, for players or NPCs
   * alike. The second line is reserved for the three states everyone is allowed
   * to know about, because a tag that said any more would tell you who is human.
   */
  private refreshTag(): void {
    const note = !this.alive
      ? 'DEAD'
      : this.flagged
        ? '*FLAGGED*'
        : this.searching
          ? 'SEARCHING'
          : '';
    if (note === this.lastNote) return;
    this.lastNote = note;
    this.tag.setText(this.info.name, note);
  }

  setFlagged(): void {
    this.flagged = true;
    this.refreshTag();
  }

  setSearching(on: boolean): void {
    this.searching = on;
    this.refreshTag();
  }

  /** What another player is visibly holding, for the guard rules and for humans. */
  get visibleWeapon(): WeaponId | null {
    return this.weapon;
  }

  get target(): CombatTarget {
    return { id: this.info.id, ...this.pose, alive: this.alive };
  }

  swing(): void {
    this.mesh.playSwing();
  }

  /** Set alive/dead, updating the mesh so the corpse actually falls down. */
  setAlive(alive: boolean): void {
    if (this._alive === alive) return;
    this._alive = alive;
    this.mesh.setDead(!alive);
    this.refreshTag();
  }

  getHit(stunDuration: number): void {
    this.mesh.playGetHit(stunDuration);
  }

  addBlood(): void {
    this.mesh.addBlood();
  }

  push(time: number, snap: PlayerSnapshot): void {
    // Weapon and life are current state, not interpolated history: applying them
    // late would mean a corpse that keeps walking for another 80 ms.
    if (this.weapon !== snap.weapon) {
      this.weapon = snap.weapon;
      this.mesh.setWeapon(snap.weapon);
    }
    if (this._alive !== snap.alive) {
      this.setAlive(snap.alive);
    }
    if (snap.flagged === true) this.flagged = true;
    this.refreshTag();

    const last = this.samples[this.samples.length - 1];
    // Snapshots can arrive out of order over a lossy link; keep the buffer sorted.
    if (last && time <= last.time) return;

    this.samples.push({
      time,
      x: snap.x,
      y: snap.y,
      z: snap.z,
      yaw: snap.yaw,
      grounded: snap.grounded,
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /**
   * @param renderTime server clock, already offset into the past
   * @param dt         real frame delta, for the walk cycle
   */
  update(renderTime: number, dt: number): void {
    if (this.samples.length === 0) return;

    while (this.samples.length > 2 && this.samples[1].time < renderTime - HISTORY_MS) {
      this.samples.shift();
    }

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];

    // Outside the buffer at either end, hold the nearest known pose rather than
    // extrapolate: a player who stopped moving should stop, not drift on.
    let a = last;
    let b = last;
    if (renderTime <= first.time) {
      a = first;
      b = first;
    } else if (renderTime < last.time) {
      for (let i = 0; i < this.samples.length - 1; i++) {
        if (this.samples[i + 1].time >= renderTime) {
          a = this.samples[i];
          b = this.samples[i + 1];
          break;
        }
      }
    }

    const span = b.time - a.time;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 0;

    const x = a.x + (b.x - a.x) * alpha;
    const y = a.y + (b.y - a.y) * alpha;
    const z = a.z + (b.z - a.z) * alpha;
    const yaw = a.yaw + shortestAngle(a.yaw, b.yaw) * alpha;

    // Derive velocity from the samples themselves so the gait matches the motion
    // actually being drawn, without the server having to send velocity.
    const vx = span > 0 ? ((b.x - a.x) / span) * 1000 : 0;
    const vz = span > 0 ? ((b.z - a.z) / span) * 1000 : 0;
    this.grounded = b.grounded;

    this.group.position.set(x, y, z);
    this.pose.x = x;
    this.pose.y = y;
    this.pose.z = z;
    this.pose.yaw = yaw;
    this.mesh.setPose(0, 0, 0, yaw);
    const local = localVelocity(vx, vz, yaw);
    this.mesh.update(dt, local.forward, local.right, this.grounded);
  }

  dispose(): void {
    this.tag.dispose();
    this.group.removeFromParent();
  }
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
