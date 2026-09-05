/**
 * Weapons lying on the floor (CLAUDE.md §7, §23).
 *
 * Shared, like combat: the server owns the real field and offline solo mode runs
 * an identical one locally, so picking up a pistol behaves the same either way.
 *
 * A ground item is deliberately dumb — an id, a weapon and a place. There is no
 * "who dropped this", because knowing that would leak information the game is
 * built on hiding: a pistol on the floor of the storage room must not tell you
 * whose pistol it was.
 */
import { GAME_CONFIG } from './constants';
import type { WeaponId } from './weapons';

export type GroundItem = {
  id: number;
  weapon: WeaponId;
  /** Floor position. */
  x: number;
  y: number;
  z: number;
};

export class ItemField {
  private readonly items = new Map<number, GroundItem>();
  private nextId = 1;

  list(): GroundItem[] {
    return [...this.items.values()];
  }

  get(id: number): GroundItem | undefined {
    return this.items.get(id);
  }

  spawn(weapon: WeaponId, x: number, y: number, z: number): GroundItem {
    const item: GroundItem = { id: this.nextId++, weapon, x, y, z };
    this.items.set(item.id, item);
    return item;
  }

  /**
   * Store an item that already has an id. Used by the client to mirror the
   * server's field — ids must match or `pickup` would refer to the wrong thing.
   */
  insert(item: GroundItem): void {
    this.items.set(item.id, item);
    this.nextId = Math.max(this.nextId, item.id + 1);
  }

  remove(id: number): GroundItem | null {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    return item;
  }

  clear(): void {
    this.items.clear();
  }

  /** Nearest item within `reach` metres horizontally, or null. */
  nearest(x: number, z: number, reach: number = GAME_CONFIG.items.reach): GroundItem | null {
    let best: GroundItem | null = null;
    let bestDistance = reach;
    for (const item of this.items.values()) {
      const d = Math.hypot(item.x - x, item.z - z);
      if (d > bestDistance) continue;
      best = item;
      bestDistance = d;
    }
    return best;
  }

  /** Drop one weapon just in front of a player. */
  dropInFront(weapon: WeaponId, x: number, y: number, z: number, yaw: number): GroundItem {
    const d = GAME_CONFIG.items.dropDistance;
    return this.spawn(weapon, x - Math.sin(yaw) * d, y, z - Math.cos(yaw) * d);
  }

  /**
   * Spill a whole inventory around a corpse (CLAUDE.md §3 — killing the Security
   * Officer must put his rifle and pistol on the floor for whoever gets there
   * first). Scattered so two weapons are individually pickable.
   */
  spill(weapons: readonly WeaponId[], x: number, y: number, z: number): GroundItem[] {
    const r = GAME_CONFIG.items.deathScatter;
    return weapons.map((weapon, i) => {
      const angle = (i / Math.max(1, weapons.length)) * Math.PI * 2;
      return this.spawn(weapon, x + Math.cos(angle) * r, y, z + Math.sin(angle) * r);
    });
  }
}
