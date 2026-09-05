/**
 * Grid pathfinding for NPCs (CLAUDE.md §17, §21).
 *
 * Guards used to walk the straight line to wherever they were going, which in a
 * compound made entirely of one-door rooms means walking into a wall and
 * standing there. A gunshot in Storage left the chokepoint guard pressed
 * against the cross-corridor wall 24 metres short of it, sweeping his head at
 * nothing. He was not being stupid on purpose; he simply had no idea the
 * doorway existed.
 *
 * So: one uniform grid over the compound, built from the same colliders the
 * client renders and the server shoots against, and A* over it. Shared and
 * deterministic, so the server and offline solo mode produce identical routes
 * with nothing to synchronise.
 *
 * This is deliberately the cheapest thing that works. 0.5 m cells over a
 * 40 × 52 m map is 8,320 cells — small enough that a full search costs less
 * than the collision pass that follows it, and small enough that nothing here
 * needs a navmesh, a hierarchy, or a budget.
 */
import { standingClear } from './collision';
import { GAME_CONFIG } from './constants';
import { COMPOUND } from './mapData';

/*
 * A note on doors, because their absence here is deliberate and load-bearing.
 *
 * The grid below is built ONCE, from `COMPOUND.colliders`, and doors are not in
 * that list — see `shared/doors.ts`. So every doorway in this grid is permanently
 * open, and a guard asked to path through a shut door is told he can. That is the
 * intent: rebuilding the grid whenever somebody pulls a door closed would be
 * expensive, and honouring shut doors would repartition the compound and strand
 * guards on the wrong side of their own patrol routes. Instead `NpcWorld` opens
 * any door a guard walks into. He has keys; a locked door is not a puzzle for him.
 *
 * Anything that needs to respect a shut door — movement, hitscan, line of sight —
 * takes its collider list as an argument and should be handed `DoorField.solids()`.
 */

/** Metres per cell. Half a player width: fine enough to find every doorway. */
const CELL = 0.5;

/** How far from an unwalkable point we will look for somewhere to stand. */
const SNAP_RADIUS = 2.0; // m

export type NavPoint = { x: number; z: number };

type Grid = {
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  blocked: Uint8Array;
};

let grid: Grid | null = null;

/**
 * Built on first use rather than at import, so pulling in this module for its
 * types does not cost a grid build.
 */
function get(): Grid {
  if (grid) return grid;

  const { minX, maxX, minZ, maxZ } = COMPOUND.bounds;
  const cols = Math.ceil((maxX - minX) / CELL);
  const rows = Math.ceil((maxZ - minZ) / CELL);
  const blocked = new Uint8Array(cols * rows);
  const radius = GAME_CONFIG.player.radius;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * CELL;
      const z = minZ + (r + 0.5) * CELL;
      if (!standingClear(x, z, radius, COMPOUND.colliders)) blocked[r * cols + c] = 1;
    }
  }

  grid = { cols, rows, minX, minZ, blocked };
  return grid;
}

/** Debug/testing: drop the cached grid so the next query rebuilds it. */
export function invalidateNavGrid(): void {
  grid = null;
}

function cellOf(g: Grid, x: number, z: number): { c: number; r: number } {
  return { c: Math.floor((x - g.minX) / CELL), r: Math.floor((z - g.minZ) / CELL) };
}

function centreOf(g: Grid, c: number, r: number): NavPoint {
  return { x: g.minX + (c + 0.5) * CELL, z: g.minZ + (r + 0.5) * CELL };
}

function open(g: Grid, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
  return g.blocked[r * g.cols + c] === 0;
}

/** Is this a spot a body could actually stand? */
export function walkable(x: number, z: number): boolean {
  const g = get();
  const { c, r } = cellOf(g, x, z);
  return open(g, c, r);
}

/**
 * Nearest standable cell to a point, searched outwards in rings. Needed at both
 * ends: a guard nudged half inside a wall by the collision push-out still has
 * to be able to leave, and a shot that hit a wall reports a noise inside it.
 */
function snap(g: Grid, x: number, z: number): { c: number; r: number } | null {
  const { c, r } = cellOf(g, x, z);
  if (open(g, c, r)) return { c, r };

  const max = Math.ceil(SNAP_RADIUS / CELL);
  for (let ring = 1; ring <= max; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        // Perimeter of the ring only; the inside was covered by earlier rings.
        if (Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
        if (open(g, c + dc, r + dr)) return { c: c + dc, r: r + dr };
      }
    }
  }
  return null;
}

/** Octile distance: the true cost of the cheapest 8-connected walk, so A* stays admissible. */
function heuristic(dc: number, dr: number): number {
  const a = Math.abs(dc);
  const b = Math.abs(dr);
  return (a > b ? a - b : b - a) + Math.SQRT2 * Math.min(a, b);
}

/** Binary min-heap keyed on f. Small enough that nothing fancier earns its keep. */
class Heap {
  private readonly items: number[] = [];
  private readonly f: Float64Array;

  constructor(size: number) {
    this.f = new Float64Array(size);
  }

  get size(): number {
    return this.items.length;
  }

  push(index: number, f: number): void {
    this.f[index] = f;
    this.items.push(index);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.f[this.items[parent]] <= this.f[this.items[i]]) break;
      const tmp = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = tmp;
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const last = this.items.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.items.length && this.f[this.items[l]] < this.f[this.items[best]]) best = l;
        if (r < this.items.length && this.f[this.items[r]] < this.f[this.items[best]]) best = r;
        if (best === i) break;
        const tmp = this.items[best];
        this.items[best] = this.items[i];
        this.items[i] = tmp;
        i = best;
      }
    }
    return top;
  }
}

/**
 * Shortest walkable route from `from` to `to`, as world-space waypoints. The
 * start is not included; the last entry is the goal itself, or the nearest
 * standable spot to it. Null if there is no route at all — callers fall back to
 * walking straight at the thing, which is no worse than the old behaviour.
 */
export function findPath(from: NavPoint, to: NavPoint): NavPoint[] | null {
  const g = get();
  const start = snap(g, from.x, from.z);
  const goal = snap(g, to.x, to.z);
  if (!start || !goal) return null;

  const startIdx = start.r * g.cols + start.c;
  const goalIdx = goal.r * g.cols + goal.c;
  if (startIdx === goalIdx) {
    return [walkable(to.x, to.z) ? { x: to.x, z: to.z } : centreOf(g, goal.c, goal.r)];
  }

  const size = g.cols * g.rows;
  const gScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const heap = new Heap(size);

  gScore[startIdx] = 0;
  heap.push(startIdx, heuristic(goal.c - start.c, goal.r - start.r));

  while (heap.size > 0) {
    const current = heap.pop();
    if (current === goalIdx) return reconstruct(g, cameFrom, current, from, to);
    if (closed[current]) continue;
    closed[current] = 1;

    const cc = current % g.cols;
    const cr = (current - cc) / g.cols;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;
        const nc = cc + dc;
        const nr = cr + dr;
        if (!open(g, nc, nr)) continue;
        // No corner cutting: squeezing diagonally between two wall cells looks
        // like clipping the corner, and with a 0.7 m-wide body it is.
        if (dc !== 0 && dr !== 0 && (!open(g, nc, cr) || !open(g, cc, nr))) continue;

        const next = nr * g.cols + nc;
        if (closed[next]) continue;
        const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
        const tentative = gScore[current] + step;
        if (tentative >= gScore[next]) continue;

        gScore[next] = tentative;
        cameFrom[next] = current;
        heap.push(next, tentative + heuristic(goal.c - nc, goal.r - nr));
      }
    }
  }

  return null;
}

function reconstruct(
  g: Grid,
  cameFrom: Int32Array,
  goalIdx: number,
  from: NavPoint,
  to: NavPoint,
): NavPoint[] {
  const cells: NavPoint[] = [];
  for (let i = goalIdx; i !== -1; i = cameFrom[i]) {
    const c = i % g.cols;
    const r = (i - c) / g.cols;
    cells.push(centreOf(g, c, r));
  }
  cells.reverse();
  cells.shift(); // the cell we are already standing in

  // Finish at the real goal rather than at a cell centre, so a guard arrives at
  // the noise and not up to 35 cm beside it.
  if (cells.length > 0 && walkable(to.x, to.z)) {
    cells[cells.length - 1] = { x: to.x, z: to.z };
  }

  return stringPull(from, cells);
}

/**
 * Drop every waypoint we can already see past. A* returns a staircase of
 * half-metre cells, and walking it verbatim makes a guard shimmy diagonally
 * down a corridor. What survives is a handful of turns, which reads as a man
 * who knows the building.
 */
function stringPull(from: NavPoint, cells: readonly NavPoint[]): NavPoint[] {
  if (cells.length <= 1) return [...cells];

  const out: NavPoint[] = [];
  let anchor = from;
  let i = 0;
  while (i < cells.length) {
    // Furthest cell still on a clear straight line from the anchor.
    let furthest = i;
    for (let j = cells.length - 1; j > i; j--) {
      if (clearLine(anchor, cells[j])) {
        furthest = j;
        break;
      }
    }
    out.push(cells[furthest]);
    anchor = cells[furthest];
    i = furthest + 1;
  }
  return out;
}

/** Can a body walk the straight segment a→b without clipping anything? */
export function clearLine(a: NavPoint, b: NavPoint): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const steps = Math.ceil(Math.hypot(dx, dz) / (CELL * 0.5));
  const radius = GAME_CONFIG.player.radius;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!standingClear(a.x + dx * t, a.z + dz * t, radius, COMPOUND.colliders)) return false;
  }
  return true;
}

/** Total walking distance of a route that starts at `from`. */
export function pathLength(from: NavPoint, path: readonly NavPoint[]): number {
  let total = 0;
  let prev = from;
  for (const p of path) {
    total += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return total;
}
