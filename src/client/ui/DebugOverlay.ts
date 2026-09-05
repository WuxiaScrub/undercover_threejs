import * as THREE from 'three';
import { GAME_CONFIG } from '../../shared/constants';
import { doorCollider, DOORS, type DoorField } from '../../shared/doors';
import { HITBOXES, HIT_CLASS } from '../../shared/hitbox';
import { COMPOUND } from '../../shared/mapData';
import type { GuardMode, NpcSnapshot } from '../../shared/npc';
import type { Collider } from '../../shared/types';

/**
 * Developer tools (CLAUDE.md §38). F1 shows collision volumes, F2 shows hit
 * regions; the text readout is always on while we are tuning.
 */
export type DebugPose = { x: number; y: number; z: number; yaw: number };

const HIT_COLORS = { head: 0xff4466, torso: 0xffaa33, limb: 0x66aaff } as const;

/** F3 vision cones, coloured by what the guard currently thinks (CLAUDE.md §19). */
const MODE_COLORS: Record<GuardMode, number> = {
  patrol: 0x55aa66,
  investigating: 0x6fb2d8,
  suspicious: 0xd8c46a,
  warning: 0xe08a3a,
  hostile: 0xe0453a,
};

export class DebugOverlay {
  private readonly colliderGroup = new THREE.Group();
  private readonly hitboxGroup = new THREE.Group();
  private readonly visionGroup = new THREE.Group();
  private readonly hitboxPool: THREE.Group[] = [];
  private readonly visionPool: THREE.Line[] = [];
  private readonly playerVolume: THREE.LineSegments;
  /** One wireframe per door, shown only while that door is actually shut. */
  private readonly doorBoxes = new Map<number, THREE.LineSegments>();

  constructor(scene: THREE.Scene, private readonly element: HTMLElement) {
    const wallMat = new THREE.LineBasicMaterial({ color: 0x44ff88 });
    const propMat = new THREE.LineBasicMaterial({ color: 0xffcc44 });
    // Doors get their own colour: an F1 pass is usually being run because
    // something blocked you, and "which of these is a door" is the first
    // question. They are drawn in the doorway, not swung — this view is about
    // what collision thinks, and collision knows only shut or open.
    const doorMat = new THREE.LineBasicMaterial({ color: 0xff66cc });

    const outline = (c: Collider, mat: THREE.LineBasicMaterial): THREE.LineSegments => {
      const w = c.max.x - c.min.x;
      const h = c.max.y - c.min.y;
      const d = c.max.z - c.min.z;
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
      const line = new THREE.LineSegments(edges, mat);
      line.position.set(c.min.x + w / 2, c.min.y + h / 2, c.min.z + d / 2);
      return line;
    };

    for (const c of COMPOUND.colliders) {
      if (c.kind === 'floor') continue;
      this.colliderGroup.add(outline(c, c.kind === 'wall' ? wallMat : propMat));
    }

    for (const def of DOORS) {
      const line = outline(doorCollider(def), doorMat);
      this.doorBoxes.set(def.id, line);
      this.colliderGroup.add(line);
    }

    this.playerVolume = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.35, 0.35, 1.8, 12, 1, true)),
      new THREE.LineBasicMaterial({ color: 0x66ccff }),
    );
    this.colliderGroup.add(this.playerVolume);

    this.colliderGroup.visible = false;
    scene.add(this.colliderGroup);

    this.hitboxGroup.visible = false;
    scene.add(this.hitboxGroup);

    this.visionGroup.visible = false;
    scene.add(this.visionGroup);
  }

  /** Cheap enough to call every frame: seven booleans. */
  updateDoors(doors: DoorField): void {
    for (const [id, line] of this.doorBoxes) line.visible = !doors.isOpen(id);
  }

  toggleColliders(): void {
    this.colliderGroup.visible = !this.colliderGroup.visible;
  }

  get collidersVisible(): boolean {
    return this.colliderGroup.visible;
  }

  toggleHitboxes(): void {
    this.hitboxGroup.visible = !this.hitboxGroup.visible;
  }

  get hitboxesVisible(): boolean {
    return this.hitboxGroup.visible;
  }

  /**
   * Draw the hit regions for every character on screen, from the same
   * shared/hitbox.ts data the server shoots at — so if the wireframe is in the
   * wrong place, the hit detection is wrong too, and you can see it.
   */
  updateHitboxes(poses: readonly DebugPose[]): void {
    if (!this.hitboxGroup.visible) return;

    while (this.hitboxPool.length < poses.length) {
      const group = new THREE.Group();
      for (const part of HITBOXES) {
        const size = {
          x: part.box.max.x - part.box.min.x,
          y: part.box.max.y - part.box.min.y,
          z: part.box.max.z - part.box.min.z,
        };
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
          new THREE.LineBasicMaterial({ color: HIT_COLORS[HIT_CLASS[part.region]] }),
        );
        line.position.set(
          (part.box.min.x + part.box.max.x) / 2,
          (part.box.min.y + part.box.max.y) / 2,
          (part.box.min.z + part.box.max.z) / 2,
        );
        group.add(line);
      }
      this.hitboxPool.push(group);
      this.hitboxGroup.add(group);
    }

    for (let i = 0; i < this.hitboxPool.length; i++) {
      const group = this.hitboxPool[i];
      const pose = poses[i];
      group.visible = pose !== undefined;
      if (!pose) continue;
      group.position.set(pose.x, pose.y, pose.z);
      group.rotation.y = pose.yaw;
    }
  }

  toggleVision(): void {
    this.visionGroup.visible = !this.visionGroup.visible;
  }

  get visionVisible(): boolean {
    return this.visionGroup.visible;
  }

  /**
   * F3: each guard's vision cone at eye height (CLAUDE.md §38). The cone is the
   * whole reason walls matter — if a guard reacts to something outside the wedge
   * drawn here, the line-of-sight check is broken.
   */
  updateVisionRays(npcs: readonly NpcSnapshot[]): void {
    if (!this.visionGroup.visible) return;

    const guards = npcs.filter((n) => n.kind === 'guard' && n.alive);
    while (this.visionPool.length < guards.length) {
      const geometry = new THREE.BufferGeometry();
      // Left edge → apex → right edge → apex → centre line: one polyline.
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(15), 3));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
      line.frustumCulled = false;
      this.visionPool.push(line);
      this.visionGroup.add(line);
    }

    const cfg = GAME_CONFIG.guards;
    for (let i = 0; i < this.visionPool.length; i++) {
      const line = this.visionPool[i];
      const guard = guards[i];
      line.visible = guard !== undefined;
      if (!guard) continue;

      const y = guard.y + 1.55;
      const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const edge = (offset: number, index: number) => {
        const a = guard.yaw + offset;
        positions.setXYZ(
          index,
          guard.x - Math.sin(a) * cfg.viewDistance,
          y,
          guard.z - Math.cos(a) * cfg.viewDistance,
        );
      };
      edge(-cfg.viewAngle, 0);
      positions.setXYZ(1, guard.x, y, guard.z);
      edge(cfg.viewAngle, 2);
      positions.setXYZ(3, guard.x, y, guard.z);
      edge(0, 4);
      positions.needsUpdate = true;
      (line.material as THREE.LineBasicMaterial).color.setHex(MODE_COLORS[guard.mode]);
    }
  }

  updatePlayerVolume(x: number, feetY: number, z: number): void {
    this.playerVolume.position.set(x, feetY + 0.9, z);
  }

  setText(lines: string[]): void {
    this.element.textContent = lines.join('\n');
  }
}
