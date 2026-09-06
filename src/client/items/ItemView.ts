import * as THREE from 'three';
import { ITEMS, isWeaponItem } from '../../shared/inventory';
import type { GroundItem } from '../../shared/items';
import { loadWeapon } from '../player/CharacterAssets';

/**
 * Weapons lying on the floor (CLAUDE.md §7, §23).
 *
 * Shows a placeholder box immediately, then swaps in the FBX model when the
 * async load resolves. The model arrives horizontal (barrel along -Z, grip at
 * origin) and already scaled to the weapon's configured length, so it needs no
 * X-rotation to lie flat. We parent it to a Group, keep a random yaw for a
 * non-squared look, and lift it so its lowest point rests on the floor.
 *
 * It gently bobs, purely so a pistol under a desk is findable at all.
 */

const IS_PLACEHOLDER_KEY = 'isPlaceholder';

export class ItemView {
  readonly group = new THREE.Group();

  private readonly objects = new Map<number, THREE.Object3D>();
  private phase = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  add(item: GroundItem): void {
    if (this.objects.has(item.id)) return;
    const def = ITEMS[item.item];
    const [bw, bh, bd] = def.size;

    // Consistent yaw per item id — a dropped item lands at an angle.
    const yaw = (item.id * 2.399) % (Math.PI * 2);

    // Start with a flat box placeholder.
    const pivot = new THREE.Group();
    pivot.position.set(item.x, item.y + 0.05, item.z);
    pivot.rotation.y = yaw;

    const boxGeo = new THREE.BoxGeometry(bw, bh, bd);
    const boxMesh = new THREE.Mesh(
      boxGeo,
      new THREE.MeshLambertMaterial({ color: def.color }),
    );
    boxMesh.castShadow = true;
    boxMesh.userData[IS_PLACEHOLDER_KEY] = true;
    pivot.add(boxMesh);

    this.group.add(pivot);
    this.objects.set(item.id, pivot);

    // Load the real FBX for weapons and swap in when it arrives.
    if (!isWeaponItem(item.item)) return;
    void loadWeapon(item.item).then((loaded) => {
      // The item may have been picked up or reset while we were loading.
      if (!this.objects.has(item.id)) return;
      if (!loaded) return;

      // Remove the placeholder box.
      boxMesh.removeFromParent();
      boxGeo.dispose();
      (boxMesh.material as THREE.Material).dispose();

      pivot.add(loaded.object);

      // Lift the group so the model's lowest point sits on the floor.
      const box = new THREE.Box3().setFromObject(pivot);
      pivot.position.y = item.y - box.min.y;
    });
  }

  remove(id: number): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.removeFromParent();
    // Only dispose geometry/material on placeholder boxes; FBX clones share
    // geometry buffers with the cached prototype, so disposing them would corrupt
    // every later pickup of the same weapon type.
    obj.traverse((child) => {
      if (!child.userData[IS_PLACEHOLDER_KEY]) return;
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) m.dispose();
      } else {
        (mesh.material as THREE.Material | undefined)?.dispose();
      }
    });
    this.objects.delete(id);
  }

  /** Replace everything — used on connect, when the server sends the whole field. */
  reset(items: readonly GroundItem[]): void {
    for (const id of [...this.objects.keys()]) this.remove(id);
    for (const item of items) this.add(item);
  }

  update(dt: number): void {
    this.phase += dt * 2;
    this.group.position.y = Math.sin(this.phase) * 0.025;
  }
}
