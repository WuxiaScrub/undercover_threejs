import * as THREE from 'three';
import type { Vec3 } from '../../shared/types';

/**
 * Muzzle flash, tracer and impact spark (CLAUDE.md §12). Placeholder visuals
 * whose only job is to make a shot legible — where it came from, where it went.
 *
 * Everything is pooled and reused: a firefight must not allocate.
 */
const TRACERS = 24;
const FLASHES = 12;
const IMPACTS = 16;

const TRACER_LIFE = 0.07;
const FLASH_LIFE = 0.05;
const IMPACT_LIFE = 0.22;

type Timed<T> = { object: T; life: number };

export class Effects {
  private readonly tracers: Timed<THREE.Line>[] = [];
  private readonly flashes: Timed<THREE.Mesh>[] = [];
  private readonly impacts: Timed<THREE.Mesh>[] = [];
  private tracerCursor = 0;
  private flashCursor = 0;
  private impactCursor = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < TRACERS; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0 }),
      );
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.tracers.push({ object: line, life: 0 });
    }

    const flashGeometry = new THREE.SphereGeometry(0.09, 6, 5);
    for (let i = 0; i < FLASHES; i++) {
      const mesh = new THREE.Mesh(
        flashGeometry,
        new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0 }),
      );
      mesh.visible = false;
      scene.add(mesh);
      this.flashes.push({ object: mesh, life: 0 });
    }

    const impactGeometry = new THREE.SphereGeometry(0.06, 6, 5);
    for (let i = 0; i < IMPACTS; i++) {
      const mesh = new THREE.Mesh(
        impactGeometry,
        new THREE.MeshBasicMaterial({ color: 0xd8c8a0, transparent: true, opacity: 0 }),
      );
      mesh.visible = false;
      scene.add(mesh);
      this.impacts.push({ object: mesh, life: 0 });
    }
  }

  /** One shot: flash at the muzzle, tracer to wherever the ray ended. */
  shot(origin: Vec3, end: Vec3, hitFlesh: boolean): void {
    const tracer = this.tracers[this.tracerCursor++ % TRACERS];
    const positions = tracer.object.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, origin.x, origin.y, origin.z);
    positions.setXYZ(1, end.x, end.y, end.z);
    positions.needsUpdate = true;
    tracer.object.visible = true;
    tracer.life = TRACER_LIFE;

    const flash = this.flashes[this.flashCursor++ % FLASHES];
    flash.object.position.set(origin.x, origin.y, origin.z);
    flash.object.visible = true;
    flash.life = FLASH_LIFE;

    this.impact(end, hitFlesh);
  }

  impact(point: Vec3, hitFlesh: boolean): void {
    const impact = this.impacts[this.impactCursor++ % IMPACTS];
    impact.object.position.set(point.x, point.y, point.z);
    (impact.object.material as THREE.MeshBasicMaterial).color.setHex(
      hitFlesh ? 0xb03020 : 0xd8c8a0,
    );
    impact.object.visible = true;
    impact.life = IMPACT_LIFE;
  }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const material = t.object.material as THREE.LineBasicMaterial;
      material.opacity = Math.max(0, t.life / TRACER_LIFE);
      if (t.life <= 0) t.object.visible = false;
    }

    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const material = f.object.material as THREE.MeshBasicMaterial;
      material.opacity = Math.max(0, f.life / FLASH_LIFE);
      if (f.life <= 0) f.object.visible = false;
    }

    for (const i of this.impacts) {
      if (i.life <= 0) continue;
      i.life -= dt;
      const fraction = Math.max(0, i.life / IMPACT_LIFE);
      (i.object.material as THREE.MeshBasicMaterial).opacity = fraction;
      const scale = 1 + (1 - fraction) * 2;
      i.object.scale.setScalar(scale);
      if (i.life <= 0) i.object.visible = false;
    }
  }
}
