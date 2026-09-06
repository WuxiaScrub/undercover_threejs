import { COMPOUND } from '../shared/mapData';
import { NET_CONFIG, round, type PlayerPublic, type PlayerSnapshot } from '../shared/net';
import { ROLE_STATS, type Role } from '../shared/roles';
import type { CombatTarget } from '../shared/combat';
import type { Perceivable } from '../shared/npc';
import type { ItemId } from '../shared/inventory';
import { startingWeapons, type WeaponId } from '../shared/weapons';

/** How far outside the compound a position may sit before it is nonsense. */
const BOUNDS_MARGIN = 3;
const MIN_Y = -6;
const MAX_Y = 30;

export type ClientState = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  grounded: boolean;
  sprinting: boolean;
};

/**
 * The server's copy of one player.
 *
 * Hybrid authority: the client simulates its own movement and reports where it
 * ended up; the server's job here is only to reject the impossible. It does not
 * re-simulate, because re-simulation without rollback would fight the client's
 * prediction and make movement — the thing this prototype exists to test — feel
 * worse than it does offline.
 */
export class PlayerState {
  yaw = 0;
  grounded = true;
  sprinting = false;

  /** Number of rejected updates; a climbing count means a cheat or a bad clock. */
  corrections = 0;

  // --- combat (milestone 3), all server-owned -------------------------------
  health: number;
  alive = true;
  /** Only what is VISIBLY held. A concealed weapon is not modelled here at all. */
  visibleWeapon: WeaponId | null = null;
  /**
   * Everything carried, openly or not. Server-owned because it decides what
   * spills onto the floor when this player dies, and because it is precisely the
   * secret a Security Officer's search exists to uncover — it is sent to its
   * owner and to nobody else.
   */
  readonly inventory = new Set<ItemId>();
  diedAtMs = 0;
  lastFireMs = 0;
  lastMeleeMs = 0;

  /**
   * This round's public roster label — `GUARD 3`, `DOCTOR`. It is what every
   * other client is told this player is called; the name they typed never leaves
   * the server (CLAUDE.md §30). Empty until a round deals one.
   */
  label = '';

  /**
   * Server-clock ms before which this player cannot be searched again. A search
   * has to cost the officer something or he simply searches everyone in a line,
   * and the immunity window is what buys the searched player time to act on
   * whatever the officer just did or did not say.
   */
  searchableAtMs = 0;

  /**
   * Whether HQ will let this player through. False only for a secretary who has
   * missed her deliveries: the restricted-zone check and the HQ door both read
   * it, so a banned secretary is challenged at HQ exactly like a doctor is.
   */
  hqAccess = true;

  private lastUpdateMs: number;

  constructor(
    readonly id: number,
    public name: string,
    public role: Role,
    public x: number,
    public y: number,
    public z: number,
    now: number,
  ) {
    this.lastUpdateMs = now;
    this.health = ROLE_STATS[role].maxHealth;
    for (const w of startingWeapons(role)) this.inventory.add(w);
  }

  get maxHealth(): number {
    return ROLE_STATS[this.role].maxHealth;
  }

  get inventoryList(): ItemId[] {
    return [...this.inventory];
  }

  /** How the guards see this player. Only the OPENLY held weapon is included. */
  get perceivable(): Perceivable {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: this.yaw,
      role: this.role,
      alive: this.alive,
      weapon: this.visibleWeapon,
      hqAccess: this.hqAccess,
    };
  }

  /**
   * What everyone else is told about this player. `name` deliberately carries
   * the roster LABEL — see the field — so that no client ever holds a mapping
   * from a character to a person.
   */
  get info(): PlayerPublic {
    return { id: this.id, name: this.label || this.name, role: this.role };
  }

  /** The shootable view of this player, for shared/combat.ts. */
  get target(): CombatTarget {
    return { id: this.id, x: this.x, y: this.y, z: this.z, yaw: this.yaw, alive: this.alive };
  }

  get snapshot(): PlayerSnapshot {
    return {
      id: this.id,
      x: round(this.x),
      y: round(this.y),
      z: round(this.z),
      yaw: round(this.yaw),
      grounded: this.grounded,
      sprinting: this.sprinting,
      alive: this.alive,
      weapon: this.visibleWeapon,
      ...(this.flagged ? { flagged: true } : {}),
    };
  }

  /** Denounced by the Telegram Operator's broadcast; set for the rest of the round. */
  flagged = false;

  /** Dev role cycling changes max health, so the current value has to follow. */
  setRole(role: Role): void {
    this.role = role;
    this.health = ROLE_STATS[role].maxHealth;
    this.alive = true;
    this.inventory.clear();
    for (const w of startingWeapons(role)) this.inventory.add(w);
  }

  /** @returns true if this damage killed them. */
  applyDamage(amount: number, now: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) return false;
    this.alive = false;
    this.diedAtMs = now;
    return true;
  }

  revive(x: number, y: number, z: number, now: number): void {
    this.health = this.maxHealth;
    this.alive = true;
    this.visibleWeapon = null;
    // Your kit stayed with your corpse; you come back with what the role issues.
    this.inventory.clear();
    for (const w of startingWeapons(this.role)) this.inventory.add(w);
    this.x = x;
    this.y = y;
    this.z = z;
    this.lastUpdateMs = now;
  }

  /** Accepted unconditionally (within bounds): respawn and debug teleports. */
  teleport(x: number, y: number, z: number, now: number): boolean {
    if (!inBounds(x, y, z)) return false;
    this.x = x;
    this.y = y;
    this.z = z;
    this.lastUpdateMs = now;
    return true;
  }

  /**
   * @returns null if the update was accepted, otherwise why it was refused.
   * On refusal the stored position is left untouched, so the correction sent
   * back to the client is the last position the server believed.
   */
  applyClientState(s: ClientState, now: number): string | null {
    if (!isFiniteState(s)) return 'non-finite state';
    if (!inBounds(s.x, s.y, s.z)) return 'outside the compound';

    // Clamped: a long gap (tab-out, hitch) must not grant an unbounded budget,
    // and a burst of updates must not shrink the budget to nothing.
    const dt = Math.min(1, Math.max(1 / 60, (now - this.lastUpdateMs) / 1000));

    const maxHorizontal =
      ROLE_STATS[this.role].sprintSpeed * NET_CONFIG.speedTolerance * dt +
      NET_CONFIG.positionSlackMeters;
    if (Math.hypot(s.x - this.x, s.z - this.z) > maxHorizontal) return 'moved too fast';

    const maxVertical = NET_CONFIG.maxVerticalSpeed * dt + NET_CONFIG.positionSlackMeters;
    if (Math.abs(s.y - this.y) > maxVertical) return 'vertical jump too large';

    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    this.yaw = s.yaw;
    this.grounded = s.grounded;
    this.sprinting = s.sprinting;
    this.lastUpdateMs = now;
    return null;
  }

  /**
   * Called after a rejection so the client is not immediately rejected again on
   * its next report while it is still snapping back.
   */
  noteCorrectionSent(now: number): void {
    this.corrections++;
    this.lastUpdateMs = now;
  }
}

function isFiniteState(s: ClientState): boolean {
  return (
    Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z) && Number.isFinite(s.yaw)
  );
}

function inBounds(x: number, y: number, z: number): boolean {
  const b = COMPOUND.bounds;
  return (
    x >= b.minX - BOUNDS_MARGIN &&
    x <= b.maxX + BOUNDS_MARGIN &&
    z >= b.minZ - BOUNDS_MARGIN &&
    z <= b.maxZ + BOUNDS_MARGIN &&
    y >= MIN_Y &&
    y <= MAX_Y
  );
}
