import type { ItemId } from './inventory';
import { CONTAINERS, type ContainerDef } from './mapData';

export type ContainerState = {
  def: ContainerDef;
  items: ItemId[];
  searched: boolean;
};

/**
 * Tracks searchable container contents for one round.
 * Shared module so the offline solo path can run the same logic.
 */
export class ContainerField {
  private readonly map = new Map<number, ContainerState>();

  seed(supplyPool: readonly ItemId[]): void {
    this.map.clear();
    const pool = [...supplyPool];
    for (const def of CONTAINERS) {
      const count = Math.floor(Math.random() * 3); // 0, 1, or 2 items
      const items: ItemId[] = [];
      for (let i = 0; i < count && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        items.push(pool.splice(idx, 1)[0]!);
      }
      this.map.set(def.id, { def, items, searched: false });
    }
  }

  /** Returns the items inside and marks the container searched. Null if already searched or unknown. */
  open(id: number): ItemId[] | null {
    const state = this.map.get(id);
    if (!state || state.searched) return null;
    state.searched = true;
    return state.items;
  }

  get(id: number): ContainerState | undefined {
    return this.map.get(id);
  }

  /** Reset for a new round (seed() must be called after). */
  reset(): void {
    this.map.clear();
  }
}
