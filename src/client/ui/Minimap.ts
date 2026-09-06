import { GAME_CONFIG } from '../../shared/constants';
import { COMPOUND } from '../../shared/mapData';

const RANGE = GAME_CONFIG.minimap.rangeMeters;
const NOISE_FADE_MS = 5000;

type NoiseMarker = { wx: number; wz: number; kind: string; bornAt: number };

/**
 * Egocentric circular minimap (Milestone E).
 * Player's facing is always "up"; geometry rotates underneath.
 * Other players are NOT drawn — that would gut the deduction game.
 */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly noises: NoiseMarker[] = [];
  private readonly size: number;

  constructor() {
    this.canvas = document.getElementById('minimap') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.size = this.canvas.width;
  }

  addNoise(wx: number, wz: number, kind: string): void {
    this.noises.push({ wx, wz, kind, bornAt: performance.now() });
  }

  draw(px: number, pz: number, yaw: number): void {
    const { ctx, size } = this;
    const half = size / 2;
    const scale = half / RANGE;
    const now = performance.now();

    ctx.clearRect(0, 0, size, size);

    // Clip to circle.
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();

    // Dark background.
    ctx.fillStyle = 'rgba(8, 10, 8, 0.82)';
    ctx.fillRect(0, 0, size, size);

    // Rotate so player's forward = up.
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-yaw);

    // Draw rooms as floor tints.
    for (const room of COMPOUND.rooms) {
      const rx = (room.minX + room.maxX) / 2 - px;
      const rz = (room.minZ + room.maxZ) / 2 - pz;
      const rw = room.maxX - room.minX;
      const rh = room.maxZ - room.minZ;
      ctx.fillStyle = 'rgba(40, 48, 40, 0.6)';
      ctx.fillRect(rx * scale - (rw * scale) / 2, rz * scale - (rh * scale) / 2, rw * scale, rh * scale);
    }

    // Draw noise markers (red dots).
    const toRemove: number[] = [];
    for (let i = 0; i < this.noises.length; i++) {
      const n = this.noises[i]!;
      const age = now - n.bornAt;
      if (age > NOISE_FADE_MS) { toRemove.push(i); continue; }
      const alpha = 1 - age / NOISE_FADE_MS;
      const nx = (n.wx - px) * scale;
      const nz = (n.wz - pz) * scale;
      ctx.beginPath();
      ctx.arc(nx, nz, 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(224, 90, 68, ${alpha})`;
      ctx.fill();
    }
    // Remove expired markers (reverse order).
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.noises.splice(toRemove[i]!, 1);
    }

    ctx.restore(); // undo rotate

    // Player dot (always at center, always facing up).
    ctx.beginPath();
    ctx.arc(half, half, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f0e9d2';
    ctx.fill();

    // "N" north indicator — a small triangle pointing in world north direction.
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.moveTo(0, -half + 8);
    ctx.lineTo(-4, -half + 16);
    ctx.lineTo(4, -half + 16);
    ctx.closePath();
    ctx.fillStyle = 'rgba(220,210,180,0.5)';
    ctx.fill();
    ctx.restore();

    ctx.restore(); // undo clip
  }
}
