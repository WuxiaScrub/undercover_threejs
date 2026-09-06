import * as THREE from 'three';
import { GAME_CONFIG } from '../../shared/constants';
import { BODY_SEGMENTS } from '../../shared/hitbox';
import { WEAPONS, type WeaponId } from '../../shared/weapons';
import {
  findRightHand,
  loadCharacter,
  loadClips,
  loadWeapon,
  ONE_SHOT_CLIPS,
  type CharacterModelId,
  type ClipId,
} from './CharacterAssets';

/**
 * A humanoid, origin at the FEET, facing -Z when yaw is 0.
 *
 * Two bodies live in here and exactly one of them is visible. The blocky
 * placeholder is built in the constructor and is what you see immediately;
 * `setModel` fetches the imported FBX and swaps it in when it arrives. That
 * split is not indecision — `CharacterMesh` is constructed synchronously by the
 * local player, every remote player and every NPC, and none of those can wait
 * on a 15 MB download. If the art is missing the placeholder simply stays, and
 * the game is fully playable either way (CLAUDE.md §29).
 *
 * Proportions of the placeholder come from shared/hitbox.ts, which is also what
 * the server shoots at, and imported models are scaled to the same total height
 * — so what you see really is what you hit.
 *
 * Handedness: facing -Z with +Y up, the character's own RIGHT is +X. This file
 * used to claim the opposite and mirrored every limb, which put the weapon in
 * the hand *away* from the over-the-shoulder camera and away from the muzzle
 * origin Game.ts fires from. Two rotations were inverted with it, so the aiming
 * arm and the punch both swung backwards. Positive `rotation.x` throws a limb
 * FORWARD (-Z); that is the sign convention for everything below.
 */
export class CharacterMesh {
  readonly group = new THREE.Group();

  /** The blocky body. Hidden, not destroyed, once a real model arrives. */
  private readonly placeholder = new THREE.Group();
  private readonly leftLeg: THREE.Object3D;
  private readonly rightLeg: THREE.Object3D;
  private readonly leftArm: THREE.Object3D;
  private readonly rightArm: THREE.Object3D;
  private readonly hand: THREE.Group;
  private readonly handRest: THREE.Vector3;
  private readonly bodyMaterial: THREE.MeshLambertMaterial;
  private readonly weaponSlots: Record<WeaponId, THREE.Group>;
  private readonly weaponAnims = new Map<WeaponId, THREE.AnimationAction>();
  private equipped: WeaponId | null = null;
  private lastEquipped: WeaponId | null = null;
  private walkPhase = 0;
  private swingTimer = 0;
  private aiming = false;
  private dead = false;
  private readonly bloodPuddle: THREE.Mesh;
  private bloodRadius = 0;

  private model: THREE.Object3D | null = null;
  private handBone: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<ClipId, THREE.AnimationAction>();
  /** LoopOnce actions — a punch, a reload, a death — driven by `playOneShot`. */
  private readonly oneShots = new Map<ClipId, THREE.AnimationAction>();
  private oneShot: THREE.AnimationAction | null = null;
  private oneShotLeft = 0;
  /** A held one-shot never hands the body back. Only a death sets this. */
  private oneShotHold = false;
  /** True once a held one-shot has finished and the mixer can stop ticking. */
  private settled = false;
  /** Whether death is being played as a clip; if not, the corpse hack runs. */
  private clipDeath = false;
  /** Scratch for `blendLocomotion`, which runs once per character per frame. */
  private readonly weights = new Map<ClipId, number>();
  /**
   * Bumped on every `setModel`. A role can change mid-round (and does, on F5),
   * so a load started for the old role may land after the new one — the token
   * is what tells that straggler it is no longer wanted.
   */
  private modelToken = 0;

  constructor(bodyColor = 0x6d7a5e, headColor = 0xc2a882) {
    const s = BODY_SEGMENTS;
    const body = new THREE.MeshLambertMaterial({ color: bodyColor });
    this.bodyMaterial = body;
    const skin = new THREE.MeshLambertMaterial({ color: headColor });
    // YXZ, not the default XYZ. The default composes as Rx·Ry·Rz, which applies
    // the death pitch in the WORLD frame *after* the yaw — so which way a corpse
    // toppled depended on which way it had been facing, and most of them landed
    // sideways. Yaw first, then pitch about the character's own left-right axis.
    this.group.rotation.order = 'YXZ';

    // Blood puddle: a flat disc lying in the XZ plane, hidden until death.
    // Radius 1 geometry scaled per-instance so `addBlood` just writes scale.
    const puddle = new THREE.Mesh(
      new THREE.CircleGeometry(1, 20),
      new THREE.MeshBasicMaterial({
        color: 0x5a0000,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    puddle.rotation.x = -Math.PI / 2;
    puddle.position.y = 0.003;
    puddle.visible = false;
    this.group.add(puddle);
    this.bloodPuddle = puddle;

    this.group.add(this.placeholder);

    const torso = box(s.torsoWidth, s.torsoHeight, s.torsoDepth, body);
    torso.position.y = s.legHeight + s.torsoHeight / 2;
    this.placeholder.add(torso);

    const head = box(s.headSize, s.headSize, s.headSize, skin);
    head.position.y = s.legHeight + s.torsoHeight + s.headSize / 2 + s.neckGap;
    this.placeholder.add(head);

    // Cap brim: makes facing direction readable at a distance.
    const brim = box(s.headSize * 0.9, 0.05, 0.14, new THREE.MeshLambertMaterial({ color: 0x3b4232 }));
    brim.position.set(0, head.position.y + 0.06, -s.headSize / 2 - 0.06);
    this.placeholder.add(brim);

    const armPivotY = s.legHeight + s.torsoHeight - 0.03;
    this.leftArm = this.makeLimb(s.armWidth, s.armLength, 0.2, body, -s.armOffset, armPivotY);
    this.rightArm = this.makeLimb(s.armWidth, s.armLength, 0.2, body, s.armOffset, armPivotY);

    const legMat = new THREE.MeshLambertMaterial({ color: 0x4a5140 });
    this.leftLeg = this.makeLimb(s.legWidth, s.legHeight, s.legDepth, legMat, -s.legOffset, s.legHeight);
    this.rightLeg = this.makeLimb(s.legWidth, s.legHeight, s.legDepth, legMat, s.legOffset, s.legHeight);

    // The hand hangs off the end of the right arm and cancels the arm's swing,
    // so a held weapon stays level with the world however the arm is posed —
    // otherwise raising the arm to aim would point the barrel at the sky. When
    // a real model takes over, the hand leaves the arm and follows the rig's
    // own hand bone instead; see `syncHandToBone`.
    this.hand = new THREE.Group();
    this.hand.position.set(0, -s.armLength + 0.05, 0);
    this.rightArm.add(this.hand);
    // The same spot expressed in body space, for when the hand is re-parented
    // off the arm and there is no bone to follow.
    this.handRest = new THREE.Vector3(s.armOffset, armPivotY - s.armLength + 0.05, 0);

    this.weaponSlots = {
      pistol: this.makeWeapon('pistol'),
      rifle: this.makeWeapon('rifle'),
    };
  }

  /** Limb pivoted at its top so it can swing like a shoulder/hip joint. */
  private makeLimb(
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    pivotY: number,
  ): THREE.Object3D {
    const pivot = new THREE.Group();
    pivot.position.set(x, pivotY, 0);
    const mesh = box(w, h, d, mat);
    mesh.position.y = -h / 2;
    pivot.add(mesh);
    this.placeholder.add(pivot);
    return pivot;
  }

  /**
   * A slot in the hand holding one weapon: a primitive to begin with, the
   * imported model once it loads. The slot itself never moves, so everything
   * that aims, hides or shows a weapon keeps working across the swap.
   */
  private makeWeapon(id: WeaponId): THREE.Group {
    const def = WEAPONS[id];
    const slot = new THREE.Group();
    slot.visible = false;
    const stub = box(0.07, 0.1, def.length, new THREE.MeshLambertMaterial({ color: def.color }));
    // Held at the grip, barrel forward (-Z) in the hand's world-levelled frame.
    stub.position.set(0, 0, -def.length / 2);
    slot.add(stub);
    this.hand.add(slot);

    void loadWeapon(id).then((loaded) => {
      if (!loaded) return;
      stub.geometry.dispose();
      stub.removeFromParent();
      slot.add(loaded.object);
      if (!loaded.fireClip) return;
      // The pistol ships a 0.2 s slide/hammer clip. One-shot and clamped: it is
      // a punctuation mark on a shot, not a loop.
      const mixer = new THREE.AnimationMixer(loaded.object);
      const action = mixer.clipAction(loaded.fireClip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.weaponAnims.set(id, action);
    });

    return slot;
  }

  /**
   * Ask for the imported model for this role or NPC kind. Safe to call before,
   * after or instead of anything else: until the file arrives (or if it never
   * does) the placeholder is what gets drawn.
   */
  setModel(id: CharacterModelId): void {
    const token = ++this.modelToken;

    void Promise.all([loadCharacter(id), loadClips()]).then(([model, clips]) => {
      // A newer request overtook this one — the role changed while it downloaded.
      if (token !== this.modelToken || !model) return;

      if (this.model) this.model.removeFromParent();
      this.actions.clear();
      this.mixer = null;

      this.model = model;
      this.group.add(model);
      this.placeholder.visible = false;

      // The weapon leaves the placeholder arm and starts tracking the rig. It
      // has to leave regardless of whether a hand bone turns up: the arm is
      // inside the hidden placeholder now, and a hidden parent would take the
      // weapon with it. Without a bone it simply rests where the hand was.
      this.handBone = findRightHand(model);
      this.group.add(this.hand);
      this.hand.position.copy(this.handRest);
      this.hand.rotation.set(0, 0, 0);

      if (clips.size === 0) return;
      this.oneShots.clear();
      this.oneShot = null;
      this.oneShotLeft = 0;
      this.oneShotHold = false;
      this.settled = false;
      this.mixer = new THREE.AnimationMixer(model);
      for (const [clipId, clip] of clips) {
        const action = this.mixer.clipAction(clip);
        if (ONE_SHOT_CLIPS.has(clipId)) {
          // Not part of the mix: parked, weightless, waiting to be fired off.
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          action.setEffectiveWeight(0);
          this.oneShots.set(clipId, action);
          continue;
        }
        // Every locomotion clip runs continuously and is mixed by weight, so
        // there is no transition to time and no clip to start or stop.
        action.play();
        action.setEffectiveWeight(clipId === 'idle' ? 1 : 0);
        this.actions.set(clipId, action);
      }
    });
  }

  /**
   * Show the weapon in hand, or nothing. Passing null is exactly what a
   * concealed weapon looks like — there is no separate "hidden weapon" visual,
   * because there must be nothing on screen to read.
   */
  setWeapon(weapon: WeaponId | null): void {
    this.equipped = weapon;
    if (weapon !== null) this.lastEquipped = weapon;
    // Never show a weapon on a corpse — a death drop already put it on the floor.
    if (this.dead) return;
    for (const id of Object.keys(this.weaponSlots) as WeaponId[]) {
      this.weaponSlots[id].visible = weapon === id;
    }
    this.aiming = weapon !== null;
  }

  /**
   * Raise or lower the firing arm without changing what is held. A guard walks
   * his route with the rifle slung and brings it up only when he means it, which
   * is what tells a player across the courtyard that he has been noticed.
   */
  setAiming(aiming: boolean): void {
    this.aiming = aiming;
  }

  get yaw(): number {
    return this.group.rotation.y;
  }

  setDead(dead: boolean): void {
    if (this.dead === dead) return;
    this.dead = dead;
    this.settled = false;

    if (!dead) {
      this.clipDeath = false;
      this.group.rotation.x = 0;
      this.bloodPuddle.visible = false;
      this.bloodRadius = 0;
      this.clearOneShot();
      return;
    }

    // A rigged body falls through the death clip, which is the whole reason the
    // hips' vertical track survives the strip in CharacterAssets. Rifle carriers
    // get the version that keeps hold of the weapon. Use lastEquipped so a remote
    // player whose weapon was cleared just before setDead still plays rifle_death.
    const heldAtDeath = this.equipped ?? this.lastEquipped;
    this.clipDeath = this.playOneShot(heldAtDeath === 'rifle' ? 'rifle_death' : 'death', {
      hold: true,
    });

    // Hide every weapon slot — the dropped item on the floor is the one copy.
    for (const id of Object.keys(this.weaponSlots) as WeaponId[]) {
      this.weaponSlots[id].visible = false;
    }

    // Puddle stays flat in world space. For clip-driven death the group stays
    // upright (animation moves the model), so the puddle's local -90° is enough.
    // For the clip-less fallback the group pitches +90°, so counter-rotate by
    // a further -90° to keep the disc on the floor.
    this.bloodRadius = BLOOD_INITIAL;
    this.bloodPuddle.rotation.x = this.clipDeath ? -Math.PI / 2 : -Math.PI;
    this.bloodPuddle.scale.setScalar(this.bloodRadius);
    this.bloodPuddle.visible = true;

    if (this.clipDeath) return;

    // No ragdolls (CLAUDE.md §9): flat on the floor is enough to read. The body
    // extends +Y from a feet origin and faces -Z, so a POSITIVE pitch swings the
    // head to +Z — backwards, onto his back. (The "positive throws a limb
    // forward" convention at the top of this file is about limbs, which hang -Y
    // from their pivot and therefore swing the other way.)
    this.group.rotation.x = Math.PI / 2;
    this.leftArm.rotation.x = 0.3;
    this.rightArm.rotation.x = -0.3;
    this.leftLeg.rotation.x = 0;
    this.rightLeg.rotation.x = 0;
    this.hand.rotation.x = 0.3;
    // `update` stops driving the mixer once dead, so settle a rigged corpse on
    // the idle pose now — otherwise it freezes mid-stride and lies there
    // running on its back. Only reachable when the death clip is missing.
    if (this.mixer) {
      const idle = this.actions.has(this.clipSet.idle) ? this.clipSet.idle : 'idle';
      for (const [id, action] of this.actions) action.setEffectiveWeight(id === idle ? 1 : 0);
      this.mixer.update(0);
      this.syncHandToBone();
    }
  }

  /** Grow the blood puddle, called when extra rounds hit the corpse. */
  addBlood(): void {
    if (!this.dead) return;
    this.bloodRadius = Math.min(this.bloodRadius + BLOOD_GROW_STEP, BLOOD_MAX);
    this.bloodPuddle.scale.setScalar(this.bloodRadius);
  }

  get isDead(): boolean {
    return this.dead;
  }

  playSwing(): void {
    // Five melee clips, picked at random. Nobody throws the same punch twice in
    // a row, and a brawl in a corridor is meant to read as a scuffle.
    this.playOneShot(MELEE_CLIPS[(Math.random() * MELEE_CLIPS.length) | 0]);
    this.swingTimer = 0.28;
  }

  /**
   * Stagger the character after a melee hit. Which clip plays depends on what
   * is visibly in hand — `equipped` is the public weapon, so it leaks nothing
   * a concealed weapon shouldn't.
   */
  playGetHit(stunDuration: number): void {
    const id = this.equipped === 'rifle' ? 'rifle_get_hit' : 'get_hit';
    this.playOneShot(id, { duration: stunDuration });
  }

  /**
   * Play the reload over the top of whatever the body is doing, stretched to the
   * weapon's authored reload time. The clip is 4.1 s and a pistol reload is
   * 1.6 s: the gameplay number wins, because that is the one the player is
   * timing his exposure against (CLAUDE.md §39).
   */
  playReload(): void {
    if (!this.equipped) return;
    this.playOneShot('reload', { duration: WEAPONS[this.equipped].reloadTime });
  }

  /** The slide, if the weapon in hand has one. Silently nothing if it does not. */
  playFire(): void {
    if (!this.equipped) return;
    this.weaponAnims.get(this.equipped)?.reset().play();
    // The rifle model ships no clip of its own; the body sells the shot instead.
    if (this.equipped === 'rifle') this.playOneShot('rifle_fire');
  }

  /**
   * Start a one-shot over the locomotion blend, replacing any already running.
   * Returns whether it actually started — the caller may need a fallback, and
   * `setDead` does.
   *
   * `duration` stretches the clip to a gameplay number rather than bending the
   * gameplay number to the art. `hold` means the clip never gives the body back:
   * that is a death, and the clamped final frame IS the corpse.
   */
  private playOneShot(id: ClipId, opts: { duration?: number; hold?: boolean } = {}): boolean {
    const action = this.oneShots.get(id);
    if (!action) return false;
    if (this.oneShot && this.oneShot !== action) this.oneShot.stop();

    const clip = action.getClip();
    const scale = opts.duration && opts.duration > 0.05 ? clip.duration / opts.duration : 1;
    action.reset();
    action.timeScale = scale;
    action.setEffectiveWeight(1);
    action.play();

    this.oneShot = action;
    this.oneShotLeft = clip.duration / scale;
    this.oneShotHold = opts.hold === true;
    return true;
  }

  private clearOneShot(): void {
    if (this.oneShot) this.oneShot.stop();
    this.oneShot = null;
    this.oneShotLeft = 0;
    this.oneShotHold = false;
  }

  /**
   * Drive the body from the velocity it is moving at, in the character's OWN
   * frame: `forward` is metres per second along its facing, `right` is metres
   * per second to its right (see `localVelocity`). A scalar speed was enough
   * for the placeholder's walk cycle, but not to choose between walking,
   * walking backwards and strafing — which is the whole point of the clip set.
   *
   * Two implementations behind one signature: a hand-rolled walk cycle on the
   * placeholder, and a weighted blend of the imported clips on a rigged model.
   */
  update(dt: number, forward: number, right: number, grounded: boolean): void {
    if (this.equipped) this.weaponAnims.get(this.equipped)?.getMixer().update(dt);

    if (this.mixer) {
      // A corpse keeps being driven until its death clip reaches the frame it
      // clamps on; after that there is nothing left to advance.
      if (this.settled) return;
      // Dead with nothing playing means there was no death clip to play and
      // `setDead` already froze the body on its idle pose.
      if (this.dead && !this.oneShot) return;
      if (this.oneShotLeft > 0) this.oneShotLeft = Math.max(0, this.oneShotLeft - dt);

      this.blendLocomotion(forward, right, grounded);
      this.mixer.update(dt);
      this.syncHandToBone();

      if (this.oneShot && this.oneShotLeft <= 0) {
        if (this.oneShotHold) this.settled = true;
        else this.clearOneShot();
      }
      return;
    }

    if (this.dead) return;

    const horizontalSpeed = Math.hypot(forward, right);
    const stride = grounded ? horizontalSpeed / GAME_CONFIG.movement.animationReferenceSpeed : 0;
    this.walkPhase += dt * stride * 8;

    const swing = Math.sin(this.walkPhase) * Math.min(0.9, stride * 0.6);
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.7;
    this.rightArm.rotation.x = swing * 0.7;

    if (!grounded) {
      this.leftArm.rotation.x = -0.5;
      this.rightArm.rotation.x = -0.5;
    }

    // A raised weapon overrides the walk cycle on the firing arm, so a
    // brandished weapon is unmistakable from across a room.
    if (this.aiming) this.rightArm.rotation.x = 1.3;

    if (this.swingTimer > 0) {
      this.swingTimer = Math.max(0, this.swingTimer - dt);
      const t = 1 - this.swingTimer / 0.28;
      this.rightArm.rotation.x = Math.sin(t * Math.PI) * 2.2;
    }

    this.hand.rotation.x = -this.rightArm.rotation.x;
  }

  /**
   * Which of the three parallel clip sets the body is animated from.
   *
   * Keyed on the weapon actually in hand, not merely on whether one is raised:
   * a guard with his rifle up moves like a man carrying a rifle, and a doctor
   * with a pistol out moves like a man carrying a pistol. Both `NpcView` and the
   * local player get the right gait from this with no further wiring.
   */
  private get clipSet(): ClipSet {
    if (!this.aiming) return UNARMED_CLIPS;
    return this.equipped === 'rifle' ? RIFLE_CLIPS : PISTOL_CLIPS;
  }

  /**
   * Mix the clip set down to one pose.
   *
   * Three independent cross-fades, so nothing ever pops: standing vs moving
   * (from speed), walk vs run (from speed), and along vs across (from the
   * direction of travel in the body's own frame). Playback is then stretched to
   * the speed actually being drawn so the feet stop skating. The character has
   * no idea what its own role's top speed is; the two reference speeds in
   * GAME_CONFIG bracket every role's walk and sprint.
   *
   * Every lookup goes through `add`, which drops ids the loader never found —
   * so a half-delivered clip set degrades to whatever part of it did arrive
   * rather than freezing the body.
   */
  private blendLocomotion(forward: number, right: number, grounded: boolean): void {
    const walkAt = GAME_CONFIG.movement.animationReferenceSpeed;
    const runAt = GAME_CONFIG.movement.animationRunSpeed;
    const speed = Math.hypot(forward, right);
    const set = this.clipSet;

    // Below a slow shuffle, treat it as standing: interpolating all the way
    // down to zero leaves a character twitching in place at the desk.
    const moving = clamp((speed - 0.2) / (walkAt - 0.2), 0, 1);
    const run = clamp((speed - walkAt) / Math.max(0.1, runAt - walkAt), 0, 1);
    // A diagonal is genuinely half a walk and half a strafe; splitting by the
    // axis components blends the two instead of snapping between them.
    const spread = Math.abs(forward) + Math.abs(right);
    const across = spread > 1e-4 ? Math.abs(right) / spread : 0;

    // A one-shot owns the body while it runs, then eases the gait back in over
    // the tail of the clip so the character does not snap out of a punch. A held
    // one — a death — never eases off at all.
    const takeover = this.oneShot
      ? this.oneShotHold
        ? 1
        : clamp(this.oneShotLeft / ONE_SHOT_FADE, 0, 1)
      : 0;
    if (this.oneShot) this.oneShot.setEffectiveWeight(takeover);
    const body = 1 - takeover;

    const weights = this.weights;
    weights.clear();
    const add = (id: ClipId | null, weight: number): void => {
      if (id === null || weight <= 0 || !this.actions.has(id)) return;
      weights.set(id, (weights.get(id) ?? 0) + weight * body);
    };

    // Airborne takes the whole body, if the set ships a jump clip at all.
    const jump = !grounded && this.actions.has(set.jump) ? 1 : 0;
    const onFoot = 1 - jump;
    const move = onFoot * moving;
    const along = move * (1 - across);

    add(set.jump, jump);
    add(set.idle, onFoot * (1 - moving));
    if (forward < 0) {
      // No unarmed run_backward exists; its share falls back onto the walk,
      // sped up by the timeScale below.
      add(set.runBackward ?? set.walkBackward, along * run);
      add(set.walkBackward, along * (1 - run));
    } else {
      add(set.run, along * run);
      add(set.walk, along * (1 - run));
    }
    // The strafes are walk-paced clips; a sprinting sidestep just plays faster.
    add(right < 0 ? set.strafeLeft : set.strafeRight, move * across);

    for (const [id, action] of this.actions) {
      action.setEffectiveWeight(weights.get(id) ?? 0);
      if (id === set.idle || id === set.jump) continue;
      const runPaced = id === set.run || id === set.runBackward;
      action.timeScale = runPaced
        ? clamp(speed / runAt, 0.6, 1.5)
        : clamp(speed / walkAt, 0.6, 1.6);
    }
  }

  /**
   * Park the weapon at the rig's hand each frame.
   *
   * Position tracks the bone; ORIENTATION deliberately does not. A hand bone's
   * local axes are whatever the rigger left them as, and the game fires from a
   * muzzle it computes itself — so the weapon keeps pointing where the character
   * faces, exactly as it did when the hand cancelled the placeholder arm's
   * swing. The barrel can therefore never end up aimed at the sky or backwards,
   * whatever clip is playing.
   */
  private syncHandToBone(): void {
    const bone = this.handBone;
    if (!bone) return;
    this.group.updateWorldMatrix(true, true);
    HAND.setFromMatrixPosition(bone.matrixWorld);
    this.group.worldToLocal(HAND);
    this.hand.position.copy(HAND);
    this.hand.rotation.set(0, 0, 0);
  }

  /** Uniform tint, driven by the player's public role. */
  setBodyColor(color: number): void {
    this.bodyMaterial.color.setHex(color);
  }

  setPose(x: number, y: number, z: number, yaw: number): void {
    // Lifted slightly when the corpse hack lays a rigid body flat, or it
    // z-fights the ground. A clip-driven death lands itself and needs no help.
    const flat = this.dead && !this.clipDeath;
    this.group.position.set(x, flat ? y + 0.06 : y, z);
    this.group.rotation.y = yaw;
  }
}

/** Scratch vector for `syncHandToBone`, which runs once per character per frame. */
const HAND = new THREE.Vector3();

const BLOOD_INITIAL = 0.18;
const BLOOD_GROW_STEP = 0.08;
const BLOOD_MAX = 0.45;

/**
 * One clip set: the same eight movement roles, exported three times — unarmed,
 * pistol, rifle. Which one drives the body is the weapon visibly in hand, so
 * drawing a gun switches the whole gait and not just the arm. `pistol_idle` and
 * `rifle_idle` are the aim poses, which is why there is no separate aim clip
 * anywhere in here.
 */
type ClipSet = {
  idle: ClipId;
  walk: ClipId;
  run: ClipId;
  walkBackward: ClipId;
  /** Null where the set has no backwards run on disk — the unarmed one. */
  runBackward: ClipId | null;
  strafeLeft: ClipId;
  strafeRight: ClipId;
  jump: ClipId;
};

const UNARMED_CLIPS: ClipSet = {
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  walkBackward: 'walk_backward',
  runBackward: null,
  strafeLeft: 'strafe_left',
  strafeRight: 'strafe_right',
  jump: 'jump',
};

const PISTOL_CLIPS: ClipSet = {
  idle: 'pistol_idle',
  walk: 'pistol_walk',
  run: 'pistol_run',
  walkBackward: 'pistol_walk_backward',
  runBackward: 'pistol_run_backward',
  strafeLeft: 'pistol_strafe_left',
  strafeRight: 'pistol_strafe_right',
  jump: 'pistol_jump',
};

const RIFLE_CLIPS: ClipSet = {
  idle: 'rifle_aim_idle',
  walk: 'rifle_walk',
  run: 'rifle_run',
  walkBackward: 'rifle_walk_backward',
  // No backwards run in the rifle set; the walk speeds up to cover it, exactly
  // as the unarmed set already does.
  runBackward: null,
  strafeLeft: 'rifle_strafe_left',
  strafeRight: 'rifle_strafe_right',
  // No rifle jump was exported. Borrowed rather than dropped: without it the
  // body keeps running its gait in mid-air, which reads far worse than a
  // pistol-shaped jump does.
  jump: 'pistol_jump',
};

/** The melee one-shots, picked from at random by `playSwing`. */
const MELEE_CLIPS: readonly ClipId[] = ['punch_1', 'punch_2', 'punch_3', 'kick_1', 'kick_2'];

/** Seconds over which a finishing one-shot hands the body back to the gait. */
const ONE_SHOT_FADE = 0.25;

/** Scratch for `localVelocity`; the result is read and dropped by the caller. */
const LOCAL = { forward: 0, right: 0 };

/**
 * Split a world-space planar velocity into the character's own forward/right,
 * which is what `CharacterMesh.update` wants. Facing `yaw`, forward is
 * (-sin yaw, -cos yaw) and the character's right is (cos yaw, -sin yaw) — see
 * the handedness note at the top of this file.
 *
 * Returns a shared object: read the two numbers, do not keep it.
 */
export function localVelocity(
  vx: number,
  vz: number,
  yaw: number,
): { forward: number; right: number } {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  LOCAL.forward = -vx * s - vz * c;
  LOCAL.right = vx * c - vz * s;
  return LOCAL;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.castShadow = true;
  return mesh;
}
