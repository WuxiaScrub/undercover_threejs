import * as THREE from 'three';
import { GAME_CONFIG } from '../../shared/constants';
import { moveBody, type Actor, type Body, type MoveResult } from '../../shared/collision';
import { ROLE_STATS, type Role, type RoleStats } from '../../shared/roles';
import type { Collider } from '../../shared/types';

const mv = GAME_CONFIG.movement;
const pl = GAME_CONFIG.player;

export type MoveInput = {
  /** Local-space axes: x = strafe right, z = forward. */
  x: number;
  z: number;
  sprint: boolean;
  jump: boolean;
};

/**
 * Movement is the highest-priority system in this prototype (CLAUDE.md §8):
 * responsive, quick to stop, no sliding, no floating, modest air control.
 * Stepped at a fixed 60 Hz by Game so feel never depends on framerate.
 */
export class PlayerController {
  readonly body: Body = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    radius: pl.radius,
    height: pl.height,
    grounded: false,
  };

  /** Yaw the character model faces; forward is (-sin y, 0, -cos y). */
  facingYaw = 0;

  /**
   * When non-null, the body slews toward this yaw (the camera yaw) rather than
   * toward the direction of travel. Set by Game when a weapon is drawn, cleared
   * when holstered, so the model faces the crosshair while aiming.
   */
  aimYaw: number | null = null;

  lastMove: MoveResult = { grounded: false, hitWall: false, steppedUp: false, landed: false };

  /** Physical stats come from the player's public role (CLAUDE.md §24). */
  stats: RoleStats = ROLE_STATS.doctor;

  stamina = ROLE_STATS.doctor.stamina.max;
  /** True once stamina is fully spent; blocks sprinting until it partly recovers. */
  exhausted = false;
  /** Whether sprint is actually being applied right now (input + stamina allow it). */
  sprinting = false;

  /** Scale on walk and sprint speed — a brandished rifle slows you down. */
  speedMultiplier = 1;

  private regenDelayLeft = 0;
  private coyote = 0;
  private jumpBuffer = 0;
  private readonly dir = new THREE.Vector3();

  setRole(role: Role): void {
    this.stats = ROLE_STATS[role];
    this.stamina = this.stats.stamina.max;
    this.exhausted = false;
    this.regenDelayLeft = 0;
  }

  /** 0..1, for the HUD bar. */
  get staminaFraction(): number {
    return this.stamina / this.stats.stamina.max;
  }

  setPosition(x: number, y: number, z: number): void {
    this.body.position.x = x;
    this.body.position.y = y;
    this.body.position.z = z;
    this.body.velocity.x = 0;
    this.body.velocity.y = 0;
    this.body.velocity.z = 0;
  }

  get speed(): number {
    return Math.hypot(this.body.velocity.x, this.body.velocity.z);
  }

  step(
    dt: number,
    input: MoveInput,
    camForward: THREE.Vector3,
    camRight: THREE.Vector3,
    colliders: readonly Collider[],
    actors: readonly Actor[] = [],
  ): void {
    const v = this.body.velocity;

    // --- desired horizontal velocity, relative to the camera ---
    this.dir.set(0, 0, 0).addScaledVector(camRight, input.x).addScaledVector(camForward, input.z);
    const moving = this.dir.lengthSq() > 1e-6;
    if (moving) this.dir.normalize();

    this.updateStamina(dt, input.sprint && moving);

    const targetSpeed = moving
      ? (this.sprinting ? this.stats.sprintSpeed : this.stats.walkSpeed) * this.speedMultiplier
      : 0;
    const targetVX = this.dir.x * targetSpeed;
    const targetVZ = this.dir.z * targetSpeed;

    const accel = this.body.grounded ? (moving ? mv.groundAccel : mv.groundDecel) : mv.airAccel;
    const dvx = targetVX - v.x;
    const dvz = targetVZ - v.z;
    const dvLen = Math.hypot(dvx, dvz);
    const maxDelta = accel * dt;
    if (dvLen > 1e-6) {
      const scale = Math.min(1, maxDelta / dvLen);
      v.x += dvx * scale;
      v.z += dvz * scale;
    }

    // --- jump, with coyote time and input buffering so it feels reliable ---
    this.coyote = this.body.grounded ? mv.coyoteTime : Math.max(0, this.coyote - dt);
    this.jumpBuffer = input.jump ? mv.jumpBuffer : Math.max(0, this.jumpBuffer - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = this.stats.jumpVelocity;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.body.grounded = false;
    }

    // --- gravity ---
    v.y -= mv.gravity * dt;
    if (v.y < -mv.maxFallSpeed) v.y = -mv.maxFallSpeed;

    this.lastMove = moveBody(this.body, dt, colliders, actors);

    // --- face the crosshair when armed, direction of travel otherwise ---
    if (this.aimYaw !== null) {
      this.facingYaw = turnToward(this.facingYaw, this.aimYaw, mv.aimTurnRate * dt);
    } else if (moving) {
      const targetYaw = Math.atan2(-this.dir.x, -this.dir.z);
      this.facingYaw = turnToward(this.facingYaw, targetYaw, 14 * dt);
    }
  }

  /**
   * Stamina limits how long you can run (CLAUDE.md §8 extension): it drains only
   * while actually sprinting, pauses briefly, then refills. Spend it all and you
   * are locked to a walk until it recovers past `recoverFraction`.
   */
  private updateStamina(dt: number, wantsSprint: boolean): void {
    const s = this.stats.stamina;
    this.sprinting = wantsSprint && !this.exhausted && this.stamina > 0;

    if (this.sprinting) {
      this.stamina -= s.drainPerSecond * dt;
      this.regenDelayLeft = s.regenDelay;
      if (this.stamina <= 0) {
        this.stamina = 0;
        this.exhausted = true;
        this.sprinting = false;
      }
      return;
    }

    if (this.regenDelayLeft > 0) {
      this.regenDelayLeft -= dt;
      return;
    }

    this.stamina = Math.min(s.max, this.stamina + s.regenPerSecond * dt);
    if (this.exhausted && this.stamina >= s.max * s.recoverFraction) this.exhausted = false;
  }
}

function turnToward(current: number, target: number, maxStep: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}
