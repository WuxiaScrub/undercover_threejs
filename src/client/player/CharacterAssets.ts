/**
 * Loading and normalising the imported FBX art (CLAUDE.md §29 — placeholder
 * geometry is fine, but the developer has real models now and they should show).
 *
 * Everything here is asynchronous and everything here is optional. `CharacterMesh`
 * is constructed synchronously all over the client, so it builds its blocky
 * placeholder first and asks for a model afterwards; if the file is missing, or
 * malformed, or the rig has no skeleton, the placeholder simply stays. That is
 * not tidiness — the guard model genuinely does not exist under the expected
 * name yet, and the game has to run anyway.
 *
 * Two normalisations happen on load, and both matter for hit detection:
 *
 *  1. **Scale.** The imported rigs come out of the loader 138 and 177 units
 *     tall — Mixamo centimetres, and not even consistently. Every model is
 *     scaled to `GAME_CONFIG.player.height` so the visible body matches
 *     `BODY_SEGMENTS`, which is what the SERVER shoots at. A model at the wrong
 *     scale means head shots that visibly miss.
 *  2. **Root motion.** The clips are motion-only and the game's own `moveBody`
 *     owns position, so the hips' position track is stripped. Leaving it in
 *     fights the physics, and it is also what makes `walk_backward` — authored
 *     22 cm lower than every other clip — sink the character into the floor.
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneRigged } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GAME_CONFIG } from '../../shared/constants';
import type { Role } from '../../shared/roles';
import { WEAPONS, type WeaponId } from '../../shared/weapons';

/** Folder name under `assets/3d/characters/`, which is also the model's name. */
export type CharacterModelId = Role | 'guard' | 'general';

/**
 * The clips the movement code can actually ask for.
 *
 * Three parallel LOCOMOTION sets — empty-handed, pistol, rifle — plus a handful
 * of ONE-SHOTS that are not a gait at all. `pistol_idle` and `rifle_idle` ARE
 * the aim poses; there is no separate aim clip.
 *
 * Four clips on disk are deliberately absent from this list, and stay unloaded
 * rather than being downloaded for nothing:
 *
 *  - `rifle_turn_left`, `rifle_turn_right`, `rifle_aim_to_idle`,
 *    `rifle_walk_to_idle`. `CharacterMesh.blendLocomotion` mixes purely on
 *    velocity — no concept of turning in place, no concept of a transition
 *    between two states — so there is nowhere to hang them. Wiring them means
 *    building the state machine CLAUDE.md §35 puts out of scope.
 */
export type ClipId =
  | 'idle'
  | 'walk'
  | 'run'
  | 'walk_backward'
  | 'strafe_left'
  | 'strafe_right'
  | 'jump'
  | 'pistol_idle'
  | 'pistol_walk'
  | 'pistol_run'
  | 'pistol_walk_backward'
  | 'pistol_run_backward'
  | 'pistol_strafe_left'
  | 'pistol_strafe_right'
  | 'pistol_jump'
  | 'rifle_idle'
  | 'rifle_walk'
  | 'rifle_run'
  | 'rifle_walk_backward'
  | 'rifle_strafe_left'
  | 'rifle_strafe_right'
  | 'death'
  | 'rifle_death'
  | 'rifle_fire'
  | 'reload'
  | 'punch_1'
  | 'punch_2'
  | 'punch_3'
  | 'kick_1'
  | 'kick_2'
  | 'rifle_aim_idle'
  | 'get_hit'
  | 'rifle_get_hit';

/**
 * Clips that play once over the top of the gait instead of being mixed into it:
 * a punch, a reload, a death. `CharacterMesh` builds these as `LoopOnce` actions
 * and drives them itself; everything else runs continuously at a weight.
 */
export const ONE_SHOT_CLIPS: ReadonlySet<ClipId> = new Set<ClipId>([
  'death',
  'rifle_death',
  'rifle_fire',
  'reload',
  'punch_1',
  'punch_2',
  'punch_3',
  'kick_1',
  'kick_2',
  'get_hit',
  'rifle_get_hit',
]);

/**
 * The one-shots whose root motion is a FALL rather than a stride.
 *
 * Stripping the hips' position wholesale is right for every gait — see the file
 * header — and wrong for a death, where the downward half of that track is the
 * only thing that puts the body on the floor. Strip these clips' horizontal
 * motion and keep their vertical, or a shot man crumples in mid-air at standing
 * hip height.
 */
const ROOT_FALL_CLIPS: ReadonlySet<ClipId> = new Set<ClipId>(['death', 'rifle_death']);

/**
 * Every URL below is rooted at `assets/` on disk: `vite.config.ts` serves that
 * folder as the public directory, so `assets/3d/x.fbx` is fetched as `/3d/x.fbx`.
 * This is the only file that builds one of these paths.
 */
const ROOT = '/3d';

/**
 * Where the clips live, in order of preference. `characters/README.md` puts them
 * flat in `animations/`; they are currently still sitting in the folder they
 * were exported into. The second entry can go once they have been moved.
 */
const CLIP_DIRS = [`${ROOT}/animations`, `${ROOT}/characters/telegram`];

/**
 * Clip id to filename. They are not the same string: the unarmed exports say
 * `walk_backwards` and `left_strafe` where the pistol ones say
 * `pistol_walk_backward` and `pistol_strafe_left`. The ids are what the
 * blending code reads, so they are the ones kept regular.
 *
 * A missing file is not an error — `loadClips` simply leaves it out of the map
 * and `blendLocomotion` optional-chains every lookup. There is no unarmed
 * `run_backward` on disk, which is why nothing asks for one.
 */
const CLIP_FILES: Record<ClipId, string> = {
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  walk_backward: 'walk_backwards',
  strafe_left: 'left_strafe',
  strafe_right: 'right_strafe',
  jump: 'jump',
  pistol_idle: 'pistol_idle',
  pistol_walk: 'pistol_walk',
  pistol_run: 'pistol_run',
  pistol_walk_backward: 'pistol_walk_backward',
  pistol_run_backward: 'pistol_run_backward',
  pistol_strafe_left: 'pistol_strafe_left',
  pistol_strafe_right: 'pistol_strafe_right',
  pistol_jump: 'pistol_jump',
  rifle_idle: 'rifle_idle',
  rifle_run: 'rifle_run',
  rifle_walk: 'rifle_walk',
  rifle_walk_backward: 'rifle_walk_backwards',
  rifle_strafe_left: 'rifle_strafe_left',
  rifle_strafe_right: 'rifle_strafe_right',
  death: 'death_forward',
  rifle_death: 'rifle_death',
  rifle_fire: 'rifle_fire',
  reload: 'reload',
  punch_1: 'melee_punch_1',
  punch_2: 'melee_punch_2',
  punch_3: 'melee_punch_3',
  kick_1: 'melee_kick_1',
  kick_2: 'melee_kick_2',
  rifle_aim_idle: 'rifle_aim_idle',
  get_hit: 'melee_get_hit',
  rifle_get_hit: 'rifle_melee_get_hit',
};

const CLIP_IDS = Object.keys(CLIP_FILES) as readonly ClipId[];

const loader = new FBXLoader();

/** One network fetch per URL, however many characters ask for it. */
const fbxCache = new Map<string, Promise<THREE.Group | null>>();

function loadFbx(url: string): Promise<THREE.Group | null> {
  let pending = fbxCache.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).catch(() => {
      // Missing art is expected during the prototype, so this is a note, not an
      // error: whatever asked for it keeps its placeholder and carries on.
      console.info(`[assets] no ${url}; keeping the placeholder`);
      return null;
    });
    fbxCache.set(url, pending);
  }
  return pending;
}

/** First of these that loads, or null if none of them do. */
async function loadFirst(urls: readonly string[]): Promise<THREE.Group | null> {
  for (const url of urls) {
    const group = await loadFbx(url);
    if (group) return group;
  }
  return null;
}

/** Strip anything that lights or shadows the rest of the scene from an import. */
function stripLights(root: THREE.Object3D): void {
  const lights: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) lights.push(o);
  });
  for (const light of lights) light.removeFromParent();
}

// ------------------------------------------------------------------ characters

const characterCache = new Map<CharacterModelId, Promise<THREE.Object3D | null>>();

/**
 * A ready-to-add copy of a character model: feet at y=0, centred on the origin,
 * scaled to player height, facing -Z like everything else in the game.
 *
 * Each caller gets its own clone — a skinned mesh cannot be shared between two
 * characters that need to hold different poses.
 */
export async function loadCharacter(id: CharacterModelId): Promise<THREE.Object3D | null> {
  let pending = characterCache.get(id);
  if (!pending) {
    pending = loadFbx(`${ROOT}/characters/${id}/${id}.fbx`).then((raw) => {
      if (!raw) return null;

      // A model with no skeleton can hold no pose and play no clip. Better the
      // blocky placeholder, which at least walks, than a sliding mannequin.
      let rigged = false;
      raw.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) rigged = true;
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      if (!rigged) {
        console.warn(`[assets] ${id}.fbx has no skeleton; keeping the placeholder`);
        return null;
      }

      stripLights(raw);
      return normalise(raw, GAME_CONFIG.player.height);
    });
    characterCache.set(id, pending);
  }

  const prototype = await pending;
  return prototype ? cloneRigged(prototype) : null;
}

/**
 * Turn a model to face -Z, scale it to a known height, and drop its feet onto
 * y=0.
 *
 * All of it applied to wrappers around the import rather than to the import
 * itself: the clips animate the model's own transforms, so anything written
 * onto those is gone the first time the mixer runs.
 */
function normalise(raw: THREE.Group, targetHeight: number): THREE.Object3D {
  const facing = new THREE.Group();
  facing.rotation.y = facesForward(raw) ? 0 : Math.PI;
  facing.add(raw);
  facing.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(facing);
  const height = box.max.y - box.min.y;
  const scale = height > 1e-6 ? targetHeight / height : 1;

  const wrapper = new THREE.Group();
  wrapper.scale.setScalar(scale);
  wrapper.position.set(
    -((box.min.x + box.max.x) / 2) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) / 2) * scale,
  );
  wrapper.add(facing);
  return wrapper;
}

/**
 * Does this rig already face -Z, the way the whole game does?
 *
 * Asked of the toes, because they are the one part of a T-pose that is
 * unambiguously in front of the body — a bounding box is symmetric and tells
 * you nothing. Mixamo exports face +Z and answer no; a model exported facing
 * the game's way answers yes and is left alone. Deciding this by measurement
 * rather than by a constant means a re-rigged model dropped into the folder
 * comes out the right way round whichever convention it was exported under,
 * instead of walking backwards until somebody notices.
 */
function facesForward(raw: THREE.Object3D): boolean {
  let toe: THREE.Object3D | null = null;
  let ankle: THREE.Object3D | null = null;
  raw.traverse((o) => {
    if (!toe && /toebase$/i.test(o.name)) toe = o;
    if (!ankle && /(right|left)foot$/i.test(o.name)) ankle = o;
  });
  if (!toe || !ankle) return true; // no toes to read: trust the export

  raw.updateMatrixWorld(true);
  const t = new THREE.Vector3().setFromMatrixPosition((toe as THREE.Object3D).matrixWorld);
  const a = new THREE.Vector3().setFromMatrixPosition((ankle as THREE.Object3D).matrixWorld);
  return t.z < a.z;
}

/**
 * The bone a weapon is held at. Mixamo names it `mixamorigRightHand` once the
 * loader has stripped the colon out of `mixamorig:RightHand`; matched loosely so
 * a re-export under a slightly different convention still finds it.
 */
export function findRightHand(model: THREE.Object3D): THREE.Object3D | null {
  const hands: THREE.Object3D[] = [];
  model.traverse((o) => {
    if (/righthand$/i.test(o.name)) hands.push(o);
  });
  return hands[0] ?? null;
}

// ------------------------------------------------------------------ animations

let clipsPending: Promise<Map<ClipId, THREE.AnimationClip>> | null = null;

/**
 * Every movement clip, loaded once and shared. Clips are read-only data — the
 * per-character state lives in the `AnimationMixer`, not in the clip — and the
 * two rigs have matching `mixamorig` bone names, so one set serves everybody.
 */
export function loadClips(): Promise<Map<ClipId, THREE.AnimationClip>> {
  if (clipsPending) return clipsPending;

  clipsPending = (async () => {
    const out = new Map<ClipId, THREE.AnimationClip>();
    await Promise.all(
      CLIP_IDS.map(async (id) => {
        const file = CLIP_FILES[id];
        const group = await loadFirst(CLIP_DIRS.map((dir) => `${dir}/${file}.fbx`));
        const clip = group?.animations[0];
        if (!clip) return;
        clip.name = id;
        if (ROOT_FALL_CLIPS.has(id)) keepOnlyTheFall(clip);
        else clip.tracks = clip.tracks.filter((t) => !isRootPosition(t.name));
        out.set(id, clip);
      }),
    );
    return out;
  })();

  return clipsPending;
}

/**
 * The hips' position track — the one part of a clip that would move the
 * character across the floor. Position belongs to `moveBody`, not to the art.
 */
function isRootPosition(trackName: string): boolean {
  return /hips.*\.position$/i.test(trackName);
}

/**
 * Hold the hips' X and Z at their opening value and leave Y alone.
 *
 * The compromise that lets a death clip work at all: the horizontal component is
 * the part that fights `moveBody` and drags a body off its own collision
 * cylinder, and the vertical component is the part that actually lays it on the
 * floor. Keep one, flatten the other.
 */
function keepOnlyTheFall(clip: THREE.AnimationClip): void {
  for (const track of clip.tracks) {
    if (!isRootPosition(track.name)) continue;
    const v = track.values;
    if (v.length < 3) continue;
    for (let i = 3; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
  }
}

// --------------------------------------------------------------------- weapons

export type WeaponModel = {
  /** Grip at the origin, barrel down -Z, scaled to the authored length. */
  object: THREE.Object3D;
  /** The pistol ships a slide/hammer clip; the rifle ships none. */
  fireClip: THREE.AnimationClip | null;
};

/**
 * Which way round is this weapon exported?
 *
 * The same question `facesForward` asks of a character, and asked the same way:
 * by measuring the model rather than trusting a convention. A gun is thin at the
 * muzzle and tall at the grip, so bin the vertices into the two halves of the
 * model's own length and compare how far each half spans vertically. The half
 * with the smaller span is the barrel.
 *
 * This is not hypothetical tidiness. The rifle ships barrel-at--Z and the pistol
 * ships barrel-at-+Z, and `loadWeapon` used to assume the rifle's convention for
 * both — which mounted the pistol 180 degrees round, muzzle in the player's palm
 * and grip pointing at whatever he was aiming at.
 */
function barrelFacesNegativeZ(raw: THREE.Object3D): boolean {
  raw.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(raw);
  const mid = (box.min.z + box.max.z) / 2;

  // [minY, maxY] of each half, tracked as we walk the vertices.
  const span = [
    { lo: Infinity, hi: -Infinity },
    { lo: Infinity, hi: -Infinity },
  ];
  const v = new THREE.Vector3();

  raw.traverse((o) => {
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

  const lowZ = span[0].hi - span[0].lo;
  const highZ = span[1].hi - span[1].lo;
  if (!Number.isFinite(lowZ) || !Number.isFinite(highZ)) return true; // no geometry: trust it
  return lowZ < highZ;
}

const weaponCache = new Map<WeaponId, Promise<WeaponModel | null>>();

/**
 * A weapon model scaled so its length is the one `shared/weapons.ts` says it is.
 * That file stays the single source of truth: range and reach are authored
 * against those numbers, so the model is fitted to the data and never the other
 * way round.
 */
export async function loadWeapon(id: WeaponId): Promise<WeaponModel | null> {
  let pending = weaponCache.get(id);
  if (!pending) {
    pending = loadFbx(`${ROOT}/weapons/${id}/${id}.fbx`).then((raw) => {
      if (!raw) return null;

      // The rifle export carries a point light. Every equipped rifle would drop
      // a live light into the scene, and six armed guards would visibly wash
      // the whole compound out.
      stripLights(raw);
      raw.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });

      // Turn the model barrel-down--Z first, then measure it, so everything
      // below is talking about the orientation the game will actually draw.
      const facing = new THREE.Group();
      facing.rotation.y = barrelFacesNegativeZ(raw) ? 0 : Math.PI;
      facing.add(raw);
      facing.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(facing);
      const modelled = box.max.z - box.min.z;
      const scale = modelled > 1e-6 ? WEAPONS[id].length / modelled : 1;

      const wrapper = new THREE.Group();
      wrapper.scale.setScalar(scale);
      // Held at the grip with the muzzle forward, which is where `muzzle()`
      // fires from and where the placeholder box used to sit.
      wrapper.position.set(0, 0, -box.max.z * scale);
      wrapper.add(facing);

      const fireClip = raw.animations.find((c) => /fire/i.test(c.name)) ?? null;
      return { object: wrapper, fireClip };
    });
    weaponCache.set(id, pending);
  }

  const prototype = await pending;
  if (!prototype) return null;
  return { object: cloneRigged(prototype.object), fireClip: prototype.fireClip };
}
