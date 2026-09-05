import * as THREE from 'three';
import type { CombatTarget } from '../../shared/combat';
import type { Perceivable } from '../../shared/npc';
import { ROLE_STATS, type Role } from '../../shared/roles';
import type { WeaponId } from '../../shared/weapons';
import { NameTag } from '../ui/NameTag';
import { CharacterMesh } from '../player/CharacterMesh';

/**
 * A stationary target for solo testing (the plan's solo mode).
 *
 * This is a DEBUG object, not a game entity: it exists so the combat matrix from
 * CLAUDE.md §37 — every weapon against every hit region against every role — can
 * be verified without a second machine. Its label shows exact health, which no
 * real character's ever does.
 *
 * Ids are negative so they can never collide with a server-assigned player id.
 */
export class DummyBot {
  readonly group = new THREE.Group();

  health: number;
  alive = true;
  /**
   * What the bot is VISIBLY holding. This exists so the mandatory §37 guard test
   * can be run by one person: put a pistol in a doctor's hand in front of a
   * guard, then step behind a wall and do it again.
   */
  weapon: WeaponId | null = null;

  private readonly mesh = new CharacterMesh();
  private readonly tag = new NameTag();

  constructor(
    readonly id: number,
    public role: Role,
    public x: number,
    public y: number,
    public z: number,
    public yaw: number,
  ) {
    this.health = ROLE_STATS[role].maxHealth;
    this.group.add(this.mesh.group);
    this.group.add(this.tag.sprite);
    this.group.position.set(x, y, z);
    this.mesh.setPose(0, 0, 0, yaw);
    this.mesh.setBodyColor(ROLE_STATS[role].bodyColor);
    this.refreshTag();
  }

  get maxHealth(): number {
    return ROLE_STATS[this.role].maxHealth;
  }

  get target(): CombatTarget {
    return { id: this.id, x: this.x, y: this.y, z: this.z, yaw: this.yaw, alive: this.alive };
  }

  /** How a guard sees this bot — role plus whatever is openly in its hands. */
  get perceivable(): Perceivable {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: this.yaw,
      role: this.role,
      alive: this.alive,
      weapon: this.weapon,
    };
  }

  /** none → pistol → rifle → none. */
  cycleWeapon(): void {
    this.weapon = this.weapon === null ? 'pistol' : this.weapon === 'pistol' ? 'rifle' : null;
    this.mesh.setWeapon(this.weapon);
    this.refreshTag();
  }

  /** @returns true if this killed it. */
  applyDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.refreshTag();
    if (this.health > 0) return false;
    this.alive = false;
    this.mesh.setDead(true);
    this.mesh.setPose(0, 0, 0, this.yaw);
    return true;
  }

  addBlood(): void {
    this.mesh.addBlood();
  }

  reset(): void {
    this.health = this.maxHealth;
    this.alive = true;
    this.mesh.setDead(false);
    this.mesh.setPose(0, 0, 0, this.yaw);
    this.refreshTag();
  }

  cycleRole(order: readonly Role[]): void {
    const next = order[(order.indexOf(this.role) + 1) % order.length];
    this.role = next;
    this.mesh.setBodyColor(ROLE_STATS[next].bodyColor);
    this.reset();
  }

  update(dt: number): void {
    this.mesh.update(dt, 0, 0, true);
  }

  private refreshTag(): void {
    const stats = ROLE_STATS[this.role];
    this.tag.setText(
      this.alive ? `${this.health} / ${stats.maxHealth}` : 'DOWN',
      `${stats.name}${this.weapon ? ` · ${this.weapon}` : ''}`,
    );
  }

  dispose(): void {
    this.tag.dispose();
    this.group.removeFromParent();
  }
}
