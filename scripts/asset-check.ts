/**
 * Imported-art tests (CLAUDE.md §37 — the "what you see is what you hit" half).
 *
 * `CharacterAssets` swallows every failure by design: missing or broken art has
 * to leave the game running on placeholders rather than crash it. That is right
 * for the client and useless for the developer, who then has no way to find out
 * that a model came in backwards except by walking around in the game looking
 * at it. This runs the real loader over the real files and prints the numbers.
 *
 * It found the first one: both Mixamo rigs face +Z, not -Z as the folder README
 * assumed, so every character would have walked backwards.
 *
 * Missing files are reported as skipped, not failed. Most of the roles have no
 * model yet and are not supposed to fail a test run because of it.
 *
 * Run under Node, where three expects a browser, so a few DOM stubs come first.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as THREE from 'three';
import { BODY_SEGMENTS } from '../src/shared/hitbox';
import { GAME_CONFIG } from '../src/shared/constants';
import { ROLE_ORDER } from '../src/shared/roles';
import { WEAPONS, type WeaponId } from '../src/shared/weapons';

// --------------------------------------------------------------- browser stubs

/** FBXLoader hands embedded textures over as blob URLs and loads them via <img>. */
(globalThis as unknown as Record<string, unknown>).window ??= {
  URL: { createObjectURL: () => 'blob:stub' },
};
(globalThis as unknown as Record<string, unknown>).document ??= {
  createElementNS: () => ({
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    set src(_v: string) {},
  }),
};
/** three reports download progress with a DOM event Node has never heard of. */
(globalThis as unknown as Record<string, unknown>).ProgressEvent ??= class {
  constructor(
    public type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }
};

/**
 * Serve the asset URLs off the disk, exactly as vite's publicDir does in the
 * browser. `Request` needs shimming too: three's FileLoader constructs one, and
 * Node refuses a root-relative URL there.
 */
const BASE = 'http://assets.local';
const ASSETS = path.join(process.cwd(), 'assets');
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);
  }
} as typeof Request;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  const url = raw.startsWith('/') ? BASE + raw : raw;
  if (!url.startsWith(BASE)) return realFetch(input, init);
  const buf = await fs.readFile(path.join(ASSETS, new URL(url).pathname.replace(/^\//, '')));
  return new Response(new Uint8Array(buf).buffer, { status: 200 });
}) as typeof fetch;

// The module reaches for `fetch` as soon as it is asked for anything, so it can
// only be imported once the stubs above are in place.
const { findRightHand, loadCharacter, loadClips, loadWeapon } = await import(
  '../src/client/player/CharacterAssets'
);

// --------------------------------------------------------------------- harness

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}
function skip(label: string, detail = ''): void {
  console.log(`  --   ${label}${detail ? `   ${detail}` : ''}`);
}

const f = (n: number) => n.toFixed(3);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Vertical extent of the geometry in each half of a model's length, as
 * [low-z half, high-z half]. Used on weapons: the muzzle end of a gun is thin
 * and the grip end is tall, so this says which way round it came out.
 */
function zHalfSpans(root: THREE.Object3D): [number, number] {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const mid = (box.min.z + box.max.z) / 2;
  const span = [
    { lo: Infinity, hi: -Infinity },
    { lo: Infinity, hi: -Infinity },
  ];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
      const half = span[v.z < mid ? 0 : 1];
      if (v.y < half.lo) half.lo = v.y;
      if (v.y > half.hi) half.hi = v.y;
    }
  });
  return [span[0].hi - span[0].lo, span[1].hi - span[1].lo];
}

/** World position of the first bone whose name matches. */
function bone(model: THREE.Object3D, re: RegExp): THREE.Vector3 | null {
  const hits: THREE.Object3D[] = [];
  model.traverse((o) => {
    if (re.test(o.name)) hits.push(o);
  });
  if (!hits[0]) return null;
  model.updateWorldMatrix(true, true);
  return new THREE.Vector3().setFromMatrixPosition(hits[0].matrixWorld);
}

// ------------------------------------------------------------------ characters

console.log('=== characters come in at game scale, facing the game way ===');

const MODEL_IDS = [...ROLE_ORDER, 'guard', 'general'] as const;
const TOLERANCE = 0.01; // m

for (const id of MODEL_IDS) {
  const model = await loadCharacter(id);
  if (!model) {
    skip(`${id}: no model yet, placeholder stays`);
    continue;
  }

  const box = new THREE.Box3().setFromObject(model);
  const height = box.max.y - box.min.y;
  check(
    `${id}: stands ${f(GAME_CONFIG.player.height)} m tall with his feet on the floor`,
    near(height, GAME_CONFIG.player.height, TOLERANCE) && near(box.min.y, 0, TOLERANCE),
    `height ${f(height)} m, feet y=${f(box.min.y)}`,
  );

  // Facing is the one thing a bounding box cannot tell you, and getting it
  // wrong means a compound full of people walking backwards.
  const toe = bone(model, /toebase$/i);
  const ankle = bone(model, /(right|left)foot$/i);
  if (toe && ankle) {
    check(`${id}: faces -Z`, toe.z < ankle.z, `toe z=${f(toe.z)} vs ankle z=${f(ankle.z)}`);
  } else {
    skip(`${id}: no toe bones, cannot verify facing`);
  }

  // Handedness: facing -Z, the character's own right is +X (see hitbox.ts).
  const hand = findRightHand(model);
  const handPos = hand ? bone(model, new RegExp(`^${hand.name}$`)) : null;
  check(
    `${id}: has a right-hand bone, and it is on his right`,
    handPos !== null && handPos.x > 0,
    hand ? `${hand.name} at x=${f(handPos?.x ?? NaN)}` : 'no hand bone — weapons will float',
  );

  // The head hitbox is the top of the body, and it is the SERVER's idea of
  // where a head shot lands. If the model's neck is not somewhere near the
  // bottom of that band, head shots miss visibly.
  const headBand = BODY_SEGMENTS.legHeight + BODY_SEGMENTS.torsoHeight;
  const neck = bone(model, /neck$/i);
  if (neck) {
    check(
      `${id}: neck sits at the bottom of the head hitbox`,
      near(neck.y, headBand, 0.12),
      `neck y=${f(neck.y)}, hitbox head band starts at ${f(headBand)}`,
    );
  } else {
    skip(`${id}: no neck bone, cannot check head alignment`);
  }

  let lights = 0;
  model.traverse((o) => {
    if ((o as THREE.Light).isLight) lights++;
  });
  check(`${id}: brings no lights of its own into the scene`, lights === 0, `${lights} lights`);
}

// ------------------------------------------------------------------ animations

console.log('\n=== clips move the limbs and nothing else ===');
{
  const clips = await loadClips();
  // All three sets, plus the one-shots. A missing file is a skip, not a failure:
  // the blend drops the id and the body falls back on whatever else loaded
  // (CharacterMesh.blendLocomotion).
  const wanted = [
    'idle',
    'walk',
    'run',
    'walk_backward',
    'strafe_left',
    'strafe_right',
    'jump',
    'pistol_idle',
    'pistol_walk',
    'pistol_run',
    'pistol_walk_backward',
    'pistol_run_backward',
    'pistol_strafe_left',
    'pistol_strafe_right',
    'pistol_jump',
    'rifle_idle',
    'rifle_walk',
    'rifle_run',
    'rifle_walk_backward',
    'rifle_strafe_left',
    'rifle_strafe_right',
    'rifle_fire',
    'reload',
    'punch_1',
    'punch_2',
    'punch_3',
    'kick_1',
    'kick_2',
    'get_hit',
    'rifle_get_hit',
    'rifle_aim_idle',
  ] as const;
  for (const id of wanted) {
    const clip = clips.get(id);
    if (!clip) {
      skip(`${id}: clip not found in assets/3d/animations or characters/telegram`);
      continue;
    }
    // Position belongs to moveBody. A surviving hips track fights the physics
    // and drags the character off its own collision cylinder.
    const roots = clip.tracks.filter((t) => /hips.*\.position$/i.test(t.name));
    check(
      `${id}: root motion stripped`,
      roots.length === 0,
      `${clip.duration.toFixed(2)}s, ${clip.tracks.length} tracks`,
    );
  }

  // The deaths are the exception, and the exception is load-bearing: the hips'
  // VERTICAL track is the only thing that lowers a shot man to the floor, so it
  // survives while X and Z are flattened. Strip it wholesale — as an over-eager
  // tidy-up of CharacterAssets easily might — and corpses crumple in mid-air.
  for (const id of ['death', 'rifle_death'] as const) {
    const clip = clips.get(id);
    if (!clip) {
      skip(`${id}: clip not found in assets/3d/animations`);
      continue;
    }
    const root = clip.tracks.find((t) => /hips.*\.position$/i.test(t.name));
    const v = root?.values;
    const flatXZ =
      !!v &&
      v.length >= 3 &&
      everyThird(v, 0).every((n) => n === v[0]) &&
      everyThird(v, 2).every((n) => n === v[2]);
    const fell = !!v && Math.max(...everyThird(v, 1)) - Math.min(...everyThird(v, 1)) > 1;
    check(
      `${id}: keeps the fall, drops the drift`,
      flatXZ && fell,
      root
        ? `hips y drops ${(Math.max(...everyThird(v!, 1)) - Math.min(...everyThird(v!, 1))).toFixed(1)} units, xz ${flatXZ ? 'held' : 'STILL MOVING'}`
        : 'no hips position track — the body will not fall',
    );
  }
}

/** Every `stride`-th component of a flat vector track, from `offset`. */
function everyThird(values: ArrayLike<number>, offset: number): number[] {
  const out: number[] = [];
  for (let i = offset; i < values.length; i += 3) out.push(values[i]);
  return out;
}

// --------------------------------------------------------------------- weapons

console.log('\n=== weapons are the length the gameplay data says they are ===');
for (const id of Object.keys(WEAPONS) as WeaponId[]) {
  const loaded = await loadWeapon(id);
  if (!loaded) {
    skip(`${id}: no model yet, placeholder stays`);
    continue;
  }

  const box = new THREE.Box3().setFromObject(loaded.object);
  const length = box.max.z - box.min.z;
  check(
    `${id}: ${f(WEAPONS[id].length)} m long, gripped at the origin, barrel down -Z`,
    near(length, WEAPONS[id].length, TOLERANCE) && near(box.max.z, 0, TOLERANCE),
    `length ${f(length)} m, grip z=${f(box.max.z)}, muzzle z=${f(box.min.z)}`,
  );

  // Length and grip position are both symmetric: a weapon mounted 180 degrees
  // round satisfies them exactly as well as a correct one does, which is how
  // the pistol shipped pointing back at the player. Shape is not symmetric.
  const [muzzleSpan, gripSpan] = zHalfSpans(loaded.object);
  check(
    `${id}: the thin end points away from the player`,
    muzzleSpan < gripSpan,
    `muzzle-half span ${f(muzzleSpan)} m vs grip-half span ${f(gripSpan)} m`,
  );

  // The rifle export ships a point light. Six armed guards carrying one would
  // visibly wash the whole compound out.
  let lights = 0;
  loaded.object.traverse((o) => {
    if ((o as THREE.Light).isLight) lights++;
  });
  check(`${id}: no stray lights`, lights === 0, `${lights} lights`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
