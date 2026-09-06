/**
 * Everything that can be picked up and carried (CLAUDE.md §3, §23).
 *
 * `ItemId` is a superset of `WeaponId` — weapons remain items so the floor,
 * inventory, and drop code all use one type. Supply items (medkits, gauze,
 * morphine) and documents (telegrams) are new; they use placeholder box
 * rendering and have no combat stats.
 *
 * `PlayerState.inventory` and `GroundItem.item` both switched to `ItemId` in
 * Milestone B. `WeaponSystem` still owns weapon management but filters inbound
 * `ItemId[]` to the weapons it understands.
 */
import { WEAPONS, type WeaponId } from './weapons';

export type ItemKind = 'weapon' | 'supply' | 'document';

export type ItemId = WeaponId | 'medkit' | 'gauze' | 'morphine' | 'telegram' | 'report';

export type ItemDef = {
  name: string;
  kind: ItemKind;
  color: number;
  /** Placeholder box dimensions [width, height, depth]. */
  size: [number, number, number];
};

export const ITEMS: Record<ItemId, ItemDef> = {
  // Weapons inherit their visual from WEAPONS but also appear here so ItemView
  // can look them up without a separate conditional path.
  pistol: {
    name: WEAPONS.pistol.name,
    kind: 'weapon',
    color: WEAPONS.pistol.color,
    size: [0.08, 0.06, WEAPONS.pistol.length],
  },
  rifle: {
    name: WEAPONS.rifle.name,
    kind: 'weapon',
    color: WEAPONS.rifle.color,
    size: [0.08, 0.06, WEAPONS.rifle.length],
  },
  medkit: {
    name: 'Medical Kit',
    kind: 'supply',
    color: 0xcc3333,
    size: [0.25, 0.12, 0.18],
  },
  gauze: {
    name: 'Gauze Roll',
    kind: 'supply',
    color: 0xe8e4d8,
    size: [0.08, 0.08, 0.14],
  },
  morphine: {
    name: 'Morphine Syrette',
    kind: 'supply',
    color: 0x8888cc,
    size: [0.04, 0.04, 0.12],
  },
  telegram: {
    name: 'Deciphered Telegram',
    kind: 'document',
    color: 0xd4c88a,
    size: [0.22, 0.02, 0.30],
  },
  /**
   * The Telegram Operator's finished signals report, naming an infiltrator.
   *
   * It is an ITEM rather than a message on purpose: a piece of paper can be
   * dropped, can be looted off a corpse, and can be taken off its owner in a
   * Security Officer's search. Making the most valuable information in the game
   * physical is what puts the operator in danger for having it.
   */
  report: {
    name: 'Signals Report',
    kind: 'document',
    color: 0xc46a4a,
    size: [0.22, 0.02, 0.30],
  },
};

export function isWeaponItem(id: ItemId): id is WeaponId {
  return id === 'pistol' || id === 'rifle';
}
