/**
 * Public occupations and their physical stats (CLAUDE.md §10, §24).
 *
 * GAME_CONFIG holds physics that is the same for everybody (gravity, acceleration,
 * air control). Anything that differs BY ROLE lives here, so balancing a role is a
 * single-table edit.
 *
 * Fitness ordering: Security Officer > Doctor = Telegram Operator > Secretary.
 * Health values are from CLAUDE.md §10 and are used from milestone 3 onward.
 */
export type Role = 'security' | 'doctor' | 'secretary' | 'telegram';

export type StaminaStats = {
  /** Seconds of continuous sprinting from full, since drain is per second. */
  max: number;
  drainPerSecond: number;
  regenPerSecond: number;
  /** Pause before stamina starts coming back after you stop sprinting. */
  regenDelay: number;
  /**
   * Once stamina is fully spent you cannot sprint again until it recovers to this
   * fraction of max. Without it, players stutter-sprint on an empty bar.
   */
  recoverFraction: number;
};

export type RoleStats = {
  id: Role;
  name: string;
  maxHealth: number;
  walkSpeed: number;
  sprintSpeed: number;
  jumpVelocity: number;
  /**
   * Damage of one unarmed strike. Deliberately far below any firearm — melee is
   * the last resort of a player who never found a weapon, not a way to win a
   * fight against one. Ordering follows physical fitness.
   */
  meleeDamage: number;
  stamina: StaminaStats;
  /** Uniform tint, so roles are distinguishable at a glance. */
  bodyColor: number;
};

export const ROLE_STATS: Record<Role, RoleStats> = {
  // Most physically fit: fastest, jumps highest, sprints longest, recovers quickest.
  security: {
    id: 'security',
    name: 'Security Officer',
    maxHealth: 200,
    walkSpeed: 4.0,
    sprintSpeed: 7,
    jumpVelocity: 6.5,
    meleeDamage: 30,
    stamina: { max: 20, drainPerSecond: 1, regenPerSecond: 1.4, regenDelay: 0.5, recoverFraction: 0.25 },
    bodyColor: 0x4d5a44,
  },

  doctor: {
    id: 'doctor',
    name: 'Doctor',
    maxHealth: 100,
    walkSpeed: 3.8,
    sprintSpeed: 6.0,
    jumpVelocity: 5, // ~0.69 m apex
    meleeDamage: 20,
    stamina: { max: 10, drainPerSecond: 1, regenPerSecond: 0.9, regenDelay: 1.0, recoverFraction: 0.25 },
    bodyColor: 0x8d9aa2,
  },

  telegram: {
    id: 'telegram',
    name: 'Telegram Operator',
    maxHealth: 120,
    walkSpeed: 4.2,
    sprintSpeed: 6.0,
    jumpVelocity: 5.5,
    meleeDamage: 20,
    stamina: { max: 12, drainPerSecond: 1, regenPerSecond: 0.9, regenDelay: 1.0, recoverFraction: 0.25 },
    bodyColor: 0x7a6f4e,
  },

  // Least fit: short sprint, slow recovery, cannot clear obstacles the officer can.
  secretary: {
    id: 'secretary',
    name: 'Secretary',
    maxHealth: 90,
    walkSpeed: 3.5,
    sprintSpeed: 4.5,
    jumpVelocity: 3.5, // ~0.34 m apex — clears a threshold, not a crate
    meleeDamage: 15,
    stamina: { max: 10, drainPerSecond: 1, regenPerSecond: 0.5, regenDelay: 1.5, recoverFraction: 0.25 },
    bodyColor: 0x6a5a6b,
  },
};

export const ROLE_ORDER: Role[] = ['security', 'doctor', 'telegram', 'secretary'];
