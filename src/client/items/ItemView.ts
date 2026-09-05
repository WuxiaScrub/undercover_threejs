import * as THREE from 'three';
import type { GroundItem } from '../../shared/items';
import { WEAPONS } from '../../shared/weapons';

/**
 * Weapons lying on the floor (CLAUDE.md §7, §23).
 *
 * Deliberately unglamorous: a small box the colour of the weapon, lying flat.
 * It carries no label and no owner — a pistol on the storage room floor must not
 * tell you whose it was, because working that out is the game.
 *
 * It does gently bob, purely so a pistol under a desk is findable at all.
 */
export class ItemView {
  readonly group = new THREE.Group();

  private readonly meshes = new Map<number, THREE.Mesh>();
  private phase = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  add(item: GroundItem): void {
    if (this.meshes.has(item.id)) return;
    const def = WEAPONS[item.weapon];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.1, def.length),
      new THREE.MeshLambertMaterial({ color: def.color }),
    );
    mesh.castShadow = true;
    mesh.position.set(item.x, item.y + 0.09, item.z);
    // Lie at an angle: a dropped weapon does not land squared to the compass.
    mesh.rotation.y = (item.id * 2.399) % (Math.PI * 2);
    mesh.rotation.z = Math.PI / 2;
    this.group.add(mesh);
    this.meshes.set(item.id, mesh);
  }

  remove(id: number): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.meshes.delete(id);
  }

  /** Replace everything — used on connect, when the server sends the whole field. */
  reset(items: readonly GroundItem[]): void {
    for (const id of [...this.meshes.keys()]) this.remove(id);
    for (const item of items) this.add(item);
  }

  update(dt: number): void {
    this.phase += dt * 2;
    this.group.position.y = Math.sin(this.phase) * 0.025;
  }
}
