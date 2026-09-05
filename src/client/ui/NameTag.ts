import * as THREE from 'three';

const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 96;
const WORLD_WIDTH = 1.9;
const WORLD_HEIGHT = WORLD_WIDTH * (CANVAS_HEIGHT / CANVAS_WIDTH);

/**
 * Floating label over a character: name and PUBLIC role (CLAUDE.md §30).
 * Faction is never rendered here — it is never even sent to other clients.
 *
 * depthTest stays on, so a label is hidden by the wall its owner is standing
 * behind. A tag visible through geometry would be a free wallhack in a game
 * whose whole point is not knowing where people are.
 */
export class NameTag {
  readonly sprite: THREE.Sprite;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;

  constructor(height = 2.2) {
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: true }),
    );
    this.sprite.scale.set(WORLD_WIDTH, WORLD_HEIGHT, 1);
    this.sprite.position.y = height;
  }

  setText(name: string, role: string): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(name, CANVAS_WIDTH / 2, 32);
    ctx.fillStyle = '#f2eee0';
    ctx.fillText(name, CANVAS_WIDTH / 2, 32);

    ctx.font = '24px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 5;
    ctx.strokeText(role.toUpperCase(), CANVAS_WIDTH / 2, 70);
    ctx.fillStyle = '#a9b39a';
    ctx.fillText(role.toUpperCase(), CANVAS_WIDTH / 2, 70);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
