/**
 * Weapons (CLAUDE.md §11, §14, §22).
 *
 * Two weapons, one slot each. The interesting part of this file is not the
 * numbers — it is `canBrandish`, the single place that decides whether a public
 * occupation is allowed to be seen holding a weapon. Guard AI, the HUD and any
 * later accusation system all ask this function; none of them re-implements it.
 */
import type { HitClass } from './hitbox';
import type { Role } from './roles';

export type WeaponId = 'pistol' | 'rifle';

/**
 * What a player's hands are doing (CLAUDE.md §14). FIRING is a transient the
 * client animates, not a replicated state — the only distinction the rest of the
 * game cares about is concealed vs visible.
 */
export type WeaponState = 'unarmed' | 'holstered' | 'brandished';

export type WeaponDef = {
  id: WeaponId;
  name: string;
  /** Effective hitscan range in metres; beyond this the shot simply misses. */
  range: number;
  /** Seconds between shots. */
  fireInterval: number;
  magazine: number;
  reloadTime: number;
  /** Cone half-angle in radians at the muzzle — the pistol is deliberately worse. */
  spread: number;
  /** Movement scale while brandished; the rifle is conspicuous AND slow. */
  speedMultiplier: number;
  /**
   * Flat damage per hit class. Deliberately NOT derived from the target's health:
   * the bullet is the same bullet whoever it hits, and the differentiator is the
   * role's HP (see ROLE_STATS). Head damage is set above every role's max health
   * so a head shot is always a kill.
   */
  damage: Record<HitClass, number>;
  /** Visual only. */
  color: number;
  length: number;
};

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    damage: { head: 200, torso: 100, limb: 50 },
    range: 35,
    fireInterval: 0.32,
    magazine: 8,
    reloadTime: 1.6,
    spread: 0.022,
    speedMultiplier: 1,
    color: 0x2b2b2f,
    length: 0.26,
  },

  rifle: {
    id: 'rifle',
    name: 'Rifle',
    // Twice the pistol, everywhere.
    damage: { head: 400, torso: 200, limb: 100 },
    range: 90,
    fireInterval: 0.95,
    magazine: 5,
    reloadTime: 2.6,
    spread: 0.004,
    speedMultiplier: 0.85,
    color: 0x4a3a28,
    length: 1.1,
  },
};

/**
 * Role authorisation, centralised (CLAUDE.md §22). A guard's suspicion check is
 * exactly `weaponVisible && !canBrandish(role, weapon)`.
 */
export function canBrandish(role: Role, weapon: WeaponId): boolean {
  void weapon; // both armed roles may openly carry either; nobody else may carry any
  return role === 'security' || role === 'guard';
}

/**
 * Who may PICK UP a weapon at all — a different question from `canBrandish`,
 * which is about being SEEN with one.
 *
 * Anyone may now carry a rifle; the constraint is that non-Security roles cannot
 * conceal it (`canConceal`). Picking it up forces it into their hands where the
 * guards can see it — which is the risk. The pistol is the concealable weapon
 * and anybody may pocket one — the whole hidden-pistol mechanic depends on it
 * (CLAUDE.md §23).
 */
export function canCarry(_role: Role, _weapon: WeaponId): boolean {
  return true;
}

/**
 * Who may HIDE a weapon (holster or conceal it from view). A rifle is a metre
 * of wood and steel: only the two roles issued one — the Security Officer and
 * the Guard — can keep it out of sight. For everyone else it is permanently
 * visible once they pick it up, and guards will immediately react to it, which
 * is exactly the trade-off that makes picking up a dead guard's rifle
 * interesting.
 */
export function canConceal(role: Role, weapon: WeaponId): boolean {
  return weapon === 'rifle' ? role === 'security' || role === 'guard' : true;
}

/**
 * What a role legitimately starts the round holding (CLAUDE.md §24).
 *
 * The Guard's rifle is the point of the role: it is the only way to be armed in
 * public without being the one officer everybody is watching. He gets no pistol
 * — the concealable weapon stays something you have to go and find.
 */
export function startingWeapons(role: Role): WeaponId[] {
  if (role === 'security') return ['pistol', 'rifle'];
  if (role === 'guard') return ['rifle'];
  return [];
}

/**
 * Which weapon, if any, a player of this role should have visibly drawn on
 * spawn/respawn. Guards carry their rifle openly — every NPC guard does too,
 * and the one guard in the compound without a rifle in hand would be a tell.
 */
export function startingVisibleWeapon(role: Role): WeaponId | null {
  if (role === 'guard') return 'rifle';
  return null;
}
