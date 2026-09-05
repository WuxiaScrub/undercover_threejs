import * as THREE from 'three';
import { GAME_CONFIG } from '../../shared/constants';
import { doorCollider, doorHinge, DOORS, type DoorField } from '../../shared/doors';
import { COMPOUND } from '../../shared/mapData';
import type { Collider } from '../../shared/types';

/**
 * Renders the compound from shared/mapData. Purely visual — collision comes from
 * the same collider list, so nothing here can change how the map plays.
 */
export class CompoundView {
  readonly group = new THREE.Group();

  private readonly materials = new Map<number, THREE.MeshLambertMaterial>();
  /** Per door: the hinge group to rotate, and the angle it is heading for. */
  private readonly leaves = new Map<number, { pivot: THREE.Group; target: number }>();

  constructor() {
    this.buildFloors();
    this.buildColliders();
    this.buildDoors();
    this.buildLabels();
  }

  /**
   * Point every leaf at where the given field says it should be. Called on any
   * change — a local toggle, a `doors` message, or a guard shouldering one open
   * — rather than polled, so the swing is only ever animating when it has to be.
   */
  syncDoors(doors: DoorField): void {
    for (const def of DOORS) {
      const leaf = this.leaves.get(def.id);
      if (leaf) leaf.target = doors.isOpen(def.id) ? (def.swing * Math.PI) / 2 : 0;
    }
  }

  /** Eases each leaf toward its target. Purely cosmetic: collision is a bit. */
  update(dt: number): void {
    // Radians per second that carry a leaf through its full quarter turn in
    // doorSwingSeconds — the door is shut or open the instant it is toggled, and
    // this only decides how long you watch it get there.
    const step = ((Math.PI / 2) / GAME_CONFIG.world.doorSwingSeconds) * dt;
    for (const leaf of this.leaves.values()) {
      const delta = leaf.target - leaf.pivot.rotation.y;
      if (Math.abs(delta) <= step) leaf.pivot.rotation.y = leaf.target;
      else leaf.pivot.rotation.y += Math.sign(delta) * step;
    }
  }

  private material(color: number): THREE.MeshLambertMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color });
      this.materials.set(color, m);
    }
    return m;
  }

  /** Per-room floor slabs, tinted so rooms read differently from a distance. */
  private buildFloors(): void {
    for (const room of COMPOUND.rooms) {
      const w = room.maxX - room.minX;
      const d = room.maxZ - room.minZ;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), this.material(room.floorColor));
      mesh.position.set(room.minX + w / 2, -0.05, room.minZ + d / 2);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  private buildColliders(): void {
    for (const c of COMPOUND.colliders) {
      if (c.kind === 'floor') continue; // drawn as room slabs above
      this.group.add(this.boxMesh(c));
    }
  }

  private boxMesh(c: Collider): THREE.Mesh {
    const w = c.max.x - c.min.x;
    const h = c.max.y - c.min.y;
    const d = c.max.z - c.min.z;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.material(c.color));
    mesh.position.set(c.min.x + w / 2, c.min.y + h / 2, c.min.z + d / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = c.label ?? c.kind;
    return mesh;
  }

  /**
   * A door leaf hangs off a pivot placed at its hinge edge, offset by half its
   * width so rotating the pivot swings the far edge through the doorway. The
   * mesh itself is the same box the collider uses, so what you see blocking you
   * is the thing that is actually blocking you.
   */
  private buildDoors(): void {
    for (const def of DOORS) {
      const pivot = new THREE.Group();
      const hinge = doorHinge(def);
      pivot.position.set(hinge.x, 0, hinge.z);

      const mesh = this.boxMesh(doorCollider(def));
      // Re-centre the leaf on the hinge: half a width along the doorway's span.
      mesh.position.set(
        def.axis === 'x' ? def.width / 2 : 0,
        mesh.position.y,
        def.axis === 'z' ? def.width / 2 : 0,
      );
      pivot.add(mesh);
      this.group.add(pivot);
      this.leaves.set(def.id, { pivot, target: 0 });
    }
  }

  /** Floating room names — cheap wayfinding while we have no real signage. */
  private buildLabels(): void {
    for (const room of COMPOUND.rooms) {
      const sprite = makeTextSprite(room.name.toUpperCase());
      // Just above wall height so signage is readable from anywhere in the compound.
      sprite.position.set(
        (room.minX + room.maxX) / 2,
        3.6,
        (room.minZ + room.maxZ) / 2,
      );
      this.group.add(sprite);
    }
  }
}

function makeTextSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f0e9d2';
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 8;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(4.2, 1.05, 1);
  return sprite;
}
