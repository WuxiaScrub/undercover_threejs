import * as THREE from 'three';
import { GAME_CONFIG } from '../../shared/constants';
import { raycastColliders } from '../../shared/collision';
import { raycastCharacter } from '../../shared/hitbox';
import type { CombatTarget } from '../../shared/combat';
import type { Collider, Vec3 } from '../../shared/types';

const cfg = GAME_CONFIG.camera;

/**
 * Conventional third-person rig: mouse rotates the camera, the character follows
 * the camera, and a spring arm pulls the camera in when a wall is behind you.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  yaw = 0; // forward is (-sin y, 0, -cos y), so yaw 0 looks north up the compound
  pitch = -0.12;

  /**
   * Set to true while the player has a weapon drawn. The rig eases toward the
   * aim profile (closer, over-shoulder, narrower FOV) and back out.
   */
  aiming = false;

  private currentDistance: number = cfg.distance;
  /** Blended values, eased between hip and aim profiles. */
  private blendedDistance = cfg.distance;
  private blendedShoulder = cfg.shoulderOffset;
  private blendedHeight = cfg.heightOffset;
  private blendedFov = cfg.fov;

  private readonly pivot = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly forwardVec = new THREE.Vector3();
  private readonly rightVec = new THREE.Vector3();
  private readonly lookVec = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(cfg.fov, aspect, cfg.near, cfg.far);
  }

  addMouse(dx: number, dy: number): void {
    this.yaw -= dx * cfg.sensitivity;
    this.pitch -= dy * cfg.sensitivity;
    this.pitch = Math.max(cfg.minPitch, Math.min(cfg.maxPitch, this.pitch));
    // Keep yaw in a sane range so it never loses float precision over a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Horizontal forward direction — what WASD is relative to. */
  get forward(): THREE.Vector3 {
    return this.forwardVec.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  get right(): THREE.Vector3 {
    return this.rightVec.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Full 3D look direction, including pitch — where the crosshair points. */
  get look(): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return this.lookVec.set(
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch,
    );
  }

  /**
   * Where the crosshair is actually pointing, `range` metres out from the camera.
   *
   * Shots leave the player's shoulder, not the camera, so firing straight down the
   * camera's own look vector would miss to one side. Aiming at this point instead
   * makes the crosshair mean what it looks like it means at gameplay distances.
   *
   * Bodies count as well as walls. If we only stopped at walls, a target in open
   * ground would leave the focus point out at max range, and the shoulder-to-there
   * ray would cross the crosshair line only out there — at 6 m it lands a couple of
   * hand-widths low, turning an aimed headshot into an arm hit.
   */
  focusPoint(
    range: number,
    colliders: readonly Collider[],
    targets: readonly CombatTarget[] = [],
    selfId = -1,
  ): THREE.Vector3 {
    const look = this.look.clone();
    const from: Vec3 = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
    const dir: Vec3 = { x: look.x, y: look.y, z: look.z };

    let distance = range;
    const wall = raycastColliders(from, dir, range, colliders);
    if (wall) distance = wall.distance;
    for (const target of targets) {
      if (!target.alive || target.id === selfId) continue;
      const body = raycastCharacter(from, dir, target, target.yaw, distance);
      if (body) distance = body.distance;
    }
    return look.multiplyScalar(distance).add(this.camera.position);
  }

  /** @param feet world position of the player's feet */
  update(feet: Vec3, dt: number, colliders: readonly Collider[]): void {
    // Ease hip vs aim profile values.
    const aim = cfg.aim;
    const rate = Math.min(1, dt * aim.blendRate);
    const targetDist = this.aiming ? aim.distance : cfg.distance;
    const targetShoulder = this.aiming ? aim.shoulderOffset : cfg.shoulderOffset;
    const targetHeight = this.aiming ? aim.heightOffset : cfg.heightOffset;
    const targetFov = this.aiming ? aim.fov : cfg.fov;

    this.blendedDistance += (targetDist - this.blendedDistance) * rate;
    this.blendedShoulder += (targetShoulder - this.blendedShoulder) * rate;
    this.blendedHeight += (targetHeight - this.blendedHeight) * rate;
    if (Math.abs(this.blendedFov - targetFov) > 0.01) {
      this.blendedFov += (targetFov - this.blendedFov) * rate;
      this.camera.fov = this.blendedFov;
      this.camera.updateProjectionMatrix();
    }

    this.pivot.set(feet.x, feet.y + GAME_CONFIG.player.eyeHeight + this.blendedHeight, feet.z);

    const cosPitch = Math.cos(this.pitch);
    const look = new THREE.Vector3(
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch,
    );

    // Where we'd like to sit: back along the look direction, offset to the shoulder.
    const shoulder = this.right.clone().multiplyScalar(this.blendedShoulder);
    const origin = this.pivot.clone().add(shoulder);
    const back = look.clone().negate();

    let distance: number = this.blendedDistance;
    const rayOrigin: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
    const rayDir: Vec3 = { x: back.x, y: back.y, z: back.z };
    const hit = raycastColliders(
      rayOrigin,
      rayDir,
      this.blendedDistance + cfg.collisionPadding,
      colliders,
    );
    if (hit) distance = Math.max(cfg.minDistance, hit.distance - cfg.collisionPadding);

    // Snap in instantly (never clip through a wall), ease back out.
    if (distance < this.currentDistance) this.currentDistance = distance;
    else this.currentDistance += (distance - this.currentDistance) * Math.min(1, dt * 8);

    this.desired.copy(origin).addScaledVector(back, this.currentDistance);
    this.camera.position.copy(this.desired);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
