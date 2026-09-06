import * as THREE from 'three';

const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 96;
const WORLD_WIDTH = 1.9;
const WORLD_HEIGHT = WORLD_WIDTH * (CANVAS_HEIGHT / CANVAS_WIDTH);

/**
 * Floating label over a character: the PUBLIC role label and nothing else
 * (CLAUDE.md §30).
 *
 * There is deliberately no username here, for players or NPCs. A tag reading
 * `GUARD 3` is the entire public identity of that character, which is what makes
 * a human indistinguishable from a routine — the moment a tag carried a name,
 * every NPC in the compound would be identifiable by not having one. Faction is
 * never rendered and never even sent to other clients.
 *
 * The second line is reserved for the few states everyone is entitled to know:
 * `DEAD`, `*FLAGGED*`, `SEARCHING`. Guard AI modes are NOT among them — printing
 * `SUSPICIOUS` over a guard's head was an instant NPC giveaway.
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

  /**
   * @param label the character's public roster label, e.g. `GUARD 3`.
   * @param note  one of the few public states, or '' for the usual case.
   */
  setText(label: string, note = ''): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    // With no second line the label sits centred, so a normal tag is one word
    // over one head rather than a word with a gap under it.
    const y = note ? 32 : CANVAS_HEIGHT / 2;
    ctx.strokeText(label, CANVAS_WIDTH / 2, y);
    ctx.fillStyle = '#f2eee0';
    ctx.fillText(label, CANVAS_WIDTH / 2, y);

    if (note) {
      const upper = note.toUpperCase();
      ctx.font = '24px ui-monospace, Consolas, monospace';
      ctx.lineWidth = 5;
      ctx.strokeText(upper, CANVAS_WIDTH / 2, 70);
      // A denunciation has to be unmissable across a courtyard; DEAD does not.
      ctx.fillStyle = upper.includes('FLAGGED') ? '#e05b4a' : '#a9b39a';
      ctx.fillText(upper, CANVAS_WIDTH / 2, 70);
    }

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
