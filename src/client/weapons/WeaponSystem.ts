import { isWeaponItem, type ItemId } from '../../shared/inventory';
import { canConceal, WEAPONS, type WeaponId, type WeaponState } from '../../shared/weapons';
import type { Role } from '../../shared/roles';

/**
 * The local player's one weapon slot (CLAUDE.md §14, §23).
 *
 * Two things are tracked and they are not the same: what you HOLD, and whether
 * it is VISIBLE. Concealing keeps the weapon — it just stops being something a
 * guard, or another player, can see. That distinction is the whole point of the
 * hidden-pistol mechanic.
 *
 * Ammunition lives here rather than on the server: the prototype gains nothing
 * from authoritative bullet counting, and the server still enforces rate of fire.
 */
export class WeaponSystem {
  private readonly owned = new Set<WeaponId>();
  private readonly ammo: Record<WeaponId, number> = { pistol: 0, rifle: 0 };

  /** The SELECTED weapon — what right click would draw. */
  held: WeaponId | null = null;
  /** Whether it is in the player's hands for all to see. */
  visible = false;

  private role: Role = 'doctor';
  private cooldown = 0;
  private reloadLeft = 0;

  setRole(role: Role): void {
    this.role = role;
    this.enforce();
  }

  /**
   * If the player holds a rifle and cannot conceal it, force it into view.
   * A non-Security role who picks up a rifle cannot holster it — the only
   * way out is to drop it with [G]. Guards will react immediately.
   */
  private enforce(): void {
    if (canConceal(this.role, 'rifle') || !this.owned.has('rifle')) return;
    this.held = 'rifle';
    this.visible = true;
  }

  /**
   * True when the role cannot conceal the held rifle and the UI should show a
   * discard hint. Used by Game to display the alert once.
   */
  get rifleForced(): boolean {
    return this.owned.has('rifle') && !canConceal(this.role, 'rifle');
  }

  get state(): WeaponState {
    if (!this.held) return 'unarmed';
    return this.visible ? 'brandished' : 'holstered';
  }

  /** What everyone else may see — null while concealed. */
  get publicWeapon(): WeaponId | null {
    return this.visible ? this.held : null;
  }

  get reloading(): boolean {
    return this.reloadLeft > 0;
  }

  get magazine(): number {
    return this.held ? this.ammo[this.held] : 0;
  }

  get capacity(): number {
    return this.held ? WEAPONS[this.held].magazine : 0;
  }

  /** Movement scale — a shouldered rifle slows you down (CLAUDE.md §11). */
  get speedMultiplier(): number {
    return this.held && this.visible ? WEAPONS[this.held].speedMultiplier : 1;
  }

  owns(id: WeaponId): boolean {
    return this.owned.has(id);
  }

  get inventory(): WeaponId[] {
    return [...this.owned];
  }

  give(id: WeaponId): void {
    this.owned.add(id);
    this.ammo[id] = WEAPONS[id].magazine;
    // Selected, but NOT drawn. Acquiring a weapon must never put it in your
    // hand: a doctor who picked up a pistol and instantly brandished it would
    // be shot by the nearest guard for a keypress he never made.
    if (!this.held) this.setHeld(id);
    this.enforce();
  }

  /**
   * Replace what we own with the server's list. The server is authoritative over
   * the inventory (it decides who won the race to a pistol on the floor), so this
   * is a reconciliation, not a merge: anything not on the list is gone.
   */
  setInventory(list: readonly ItemId[]): void {
    // WeaponSystem only cares about weapons; supply items and documents bypass it.
    return this.setWeaponInventory(list.filter(isWeaponItem));
  }

  private setWeaponInventory(list: readonly WeaponId[]): void {
    const held = this.held;
    const visible = this.visible;

    for (const id of list) if (!this.owned.has(id)) this.give(id);
    for (const id of [...this.owned]) if (!list.includes(id)) this.remove(id);

    // Restore what the hands were doing. Use the current slot (which give() may
    // have just set) rather than the snapshot taken before the loop: the snapshot
    // is null for an empty-handed player, so `keep` would be false even after
    // give() selected a weapon and we would lose it again immediately.
    // Acquiring a weapon must NEVER draw it: a doctor who finds a pistol and
    // instantly brandishes it in front of a guard would be shot for a keypress
    // he never made. `visible` enforces that invariant, not `held`.
    const candidate = this.held ?? held;
    const keep = candidate !== null && this.owned.has(candidate);
    this.held = keep ? candidate : null;
    this.visible = keep && visible && (candidate === held);
    this.enforce();
  }

  /**
   * Choose which weapon is selected WITHOUT changing whether it is on show.
   * Switching while openly carrying stays open; switching while concealed stays
   * concealed. Nothing you do with the scroll wheel should ever be the reason a
   * guard shoots you.
   */
  setHeld(id: WeaponId | null): void {
    if (id !== null && !this.owned.has(id)) return;
    if (this.held === id) return;
    this.held = id;
    this.reloadLeft = 0;
    if (id === null) this.visible = false;
    // No instant shot on the swap.
    if (this.visible) this.cooldown = Math.max(this.cooldown, 0.2);
    this.enforce();
  }

  /** Scroll through what you own. Positive = next. No-op with fewer than two. */
  cycle(steps: number): void {
    const list = this.inventory;
    if (list.length < 2 || steps === 0) return;
    const at = this.held ? list.indexOf(this.held) : -1;
    const next = (((at + steps) % list.length) + list.length) % list.length;
    this.setHeld(list[next]);
    this.enforce();
  }

  /**
   * Draw the selected weapon, or put it away — the single most consequential
   * button in the game, which is why it is a mouse button and not a number key.
   *
   * Returns true if the weapon was just drawn, false if put away (or nothing
   * happened). Returns 'refused' if the role cannot conceal the held rifle —
   * the caller should tell the player why ([G] to discard).
   */
  toggleBrandish(): boolean | 'refused' {
    if (!this.held) return false;
    if (this.visible) {
      // Block holstering a rifle for a non-Security role.
      if (!canConceal(this.role, this.held)) return 'refused';
      this.conceal();
      return false;
    }
    this.visible = true;
    this.reloadLeft = 0;
    this.cooldown = Math.max(this.cooldown, 0.2); // no instant shot on the draw
    this.enforce();
    return true;
  }

  /** Put it away without dropping it. */
  conceal(): void {
    this.visible = false;
    this.reloadLeft = 0;
    this.enforce();
  }

  /** Throw away the selected weapon. Returns what left your hands. */
  drop(): WeaponId | null {
    const dropped = this.held;
    if (dropped) this.remove(dropped);
    return dropped;
  }

  /** Throw away a named weapon, drawn or in the bag. */
  discard(id: WeaponId): WeaponId | null {
    if (!this.owned.has(id)) return null;
    this.remove(id);
    return id;
  }

  /** Lose one named weapon — put on the floor, or taken away by the server. */
  remove(id: WeaponId): void {
    if (!this.owned.delete(id)) return;
    if (this.held !== id) return;
    this.held = this.owned.values().next().value ?? null;
    this.visible = false;
    this.enforce();
  }

  clear(): void {
    this.owned.clear();
    this.held = null;
    this.visible = false;
    this.reloadLeft = 0;
  }

  canFire(): boolean {
    return (
      this.held !== null && this.visible && this.cooldown <= 0 && !this.reloading && this.magazine > 0
    );
  }

  /** Spend a round. Returns the weapon fired, or null if the shot was not allowed. */
  consumeShot(): WeaponId | null {
    if (!this.canFire() || !this.held) return null;
    this.ammo[this.held]--;
    this.cooldown = WEAPONS[this.held].fireInterval;
    return this.held;
  }

  /** Returns whether a reload actually began — the body only animates if so. */
  startReload(): boolean {
    if (!this.held || this.reloading) return false;
    if (this.magazine >= this.capacity) return false;
    this.reloadLeft = WEAPONS[this.held].reloadTime;
    return true;
  }

  update(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        if (this.held) this.ammo[this.held] = WEAPONS[this.held].magazine;
      }
    }
  }
}
