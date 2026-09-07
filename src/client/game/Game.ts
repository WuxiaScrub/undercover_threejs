import * as THREE from 'three';
import type { Actor } from '../../shared/collision';
import {
  damageFor,
  meleeDamageFor,
  resolveMelee,
  resolveShot,
  type CombatTarget,
} from '../../shared/combat';
import { GAME_CONFIG } from '../../shared/constants';
import { doorById, doorPermits, DoorField, type DoorDef } from '../../shared/doors';
import { PatrolDuty, type DutyStatus } from '../../shared/duty';
import { PatientSystem } from '../../shared/medical';
import type { Faction } from '../../shared/factions';
import { ITEMS, isWeaponItem, type ItemId } from '../../shared/inventory';
import { ItemField } from '../../shared/items';
import { COMPOUND, CONTAINERS, HIDDEN_PISTOL_SPOTS, restrictedZoneAt } from '../../shared/mapData';
import {
  NET_CONFIG,
  round,
  type PlayerPublic,
  type RoundPhase,
  type ServerMessage,
} from '../../shared/net';
import {
  NpcWorld,
  type GuardVoiceCue,
  type NpcSnapshot,
  type Perceivable,
} from '../../shared/npc';
import { ROLE_ORDER, ROLE_STATS, type Role } from '../../shared/roles';
import type { Vec3 } from '../../shared/types';
import {
  WEAPONS,
  canBrandish,
  canCarry,
  startingWeapons,
  startingVisibleWeapon,
  type WeaponId,
} from '../../shared/weapons';
import { Audio } from '../fx/Audio';
import { Effects } from '../fx/Effects';
import { ItemView } from '../items/ItemView';
import { CompoundView } from '../map/CompoundView';
import { Connection, type ConnectionStatus } from '../net/Connection';
import { DummyBot } from '../npc/DummyBot';
import { NpcView } from '../npc/NpcView';
import { CharacterMesh, localVelocity } from '../player/CharacterMesh';
import { PlayerController } from '../player/PlayerController';
import { RemotePlayer } from '../player/RemotePlayer';
import { DebugOverlay, type DebugPose } from '../ui/DebugOverlay';
import { HUD } from '../ui/HUD';
import { Minimap } from '../ui/Minimap';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { CameraRig } from './CameraRig';
import { Input } from './Input';

const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

const STATE_INTERVAL = 1 / NET_CONFIG.stateHz;
const PING_INTERVAL = 1;

const MOUSE_LEFT = 0;
const MOUSE_RIGHT = 2;
const combatCfg = GAME_CONFIG.combat;
const roundCfg = GAME_CONFIG.round;
const HIDDEN_PISTOL_COUNT = 3;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly input: Input;
  private readonly debug: DebugOverlay;
  private readonly hud: HUD;
  private readonly effects: Effects;
  private readonly audio: Audio;
  private readonly itemView: ItemView;
  private readonly npcView: NpcView;
  private readonly player = new PlayerController();
  private readonly playerMesh = new CharacterMesh();
  private readonly weapons = new WeaponSystem();

  /** No role assignment until milestone 5; F5 cycles it for feel-testing. */
  private roleIndex = ROLE_ORDER.indexOf('doctor');
  private accumulator = 0;
  private lastTime = 0;
  private frameTimeMs = 0;
  /** Previous frame's grounded flag, so a landing can be heard exactly once. */
  private wasGrounded = true;

  // --- combat (milestone 3) -----------------------------------------------
  /**
   * Health is server-owned when connected — these fields are just the last value
   * the server told us. In solo mode nothing shoots back, so they are ours.
   */
  private health = ROLE_STATS.doctor.maxHealth;
  private maxHealth = ROLE_STATS.doctor.maxHealth;
  private alive = true;
  private deadSince = 0;
  private drawWeaponOnNextInventory = false;
  private meleeCooldown = 0;
  /** Seconds remaining where the player cannot move (melee swing root or stun). */
  private moveLock = 0;
  private lastSentWeapon: WeaponId | null = null;
  private lastHitText = '';
  /** Weapons offered by the open discard menu, or null when it is shut. */
  private discardMenu: WeaponId[] | null = null;
  /** Full item inventory (weapons + supplies + documents), server-authoritative. */
  private fullInventory: ItemId[] = [];
  /** The restricted zone we last warned about, so it is said once per entry. */
  private lastZoneWarning: string | null = null;

  private readonly minimap: Minimap;

  // container hold-to-interact
  private searchTarget: { id: number; label: string; x: number; z: number } | null = null;
  private searchTimer = 0;
  /** Set while a telegram puzzle is waiting for an answer. */
  private puzzleActive = false;
  /**
   * The search this client is a party to, or null.
   *
   * `items` is present ONLY when we are the officer — the server never puts the
   * list on anybody else's copy, and the client must not invent one, because an
   * officer being able to lie about what he found is the whole mechanic
   * (CLAUDE.md §16).
   */
  private activeSearch: { officer: number; target: number; items: ItemId[] | null } | null = null;
  /** Ids currently held in a search, for the SEARCHING tag on NPCs. */
  private readonly searchingIds = new Set<number>();
  /** Candidates from the last signals report read, while its panel is open. */
  private reportCandidates: readonly { id: number; label: string }[] = [];

  private readonly bots: DummyBot[] = [];
  private nextBotId = -1;

  // --- items and NPCs (milestone 4) ---------------------------------------
  /**
   * What is lying on the floor. Online this mirrors the server's field, ids and
   * all, because `pickup` names an item by id. Offline it IS the field.
   */
  private readonly items = new ItemField();
  /**
   * Which doors are open. Online this mirrors the server, which is the only
   * thing allowed to change it; offline it IS the state. Either way it is what
   * every collider list in this file is built from, so a shut door stops us,
   * our bullets and our line of sight exactly as a wall does.
   */
  private readonly doors = new DoorField();
  /** Held rather than dropped into the scene: the door leaves need ticking. */
  private readonly compound = new CompoundView();

  // --- the round (milestone 5) --------------------------------------------
  /**
   * Online the server owns all of this and we only mirror it. Offline we run a
   * one-player round ourselves so the win path can be walked solo — the same
   * arrangement as `tickOfflineNpcs`, and for the same reason.
   */
  private roundPhase: RoundPhase = 'lobby';
  /** performance.now() ms this phase ends at; 0 when it has no deadline. */
  private roundEndsAt = 0;
  private roundPlayers = 1;
  /** YOUR faction. Never rendered unless F4 has been pressed. */
  private faction: Faction | null = null;
  /**
   * The patrol line, as last told to us, plus the clock reading when we were
   * told it. The server sends this only when something changes, so the seconds
   * are counted down here — same arrangement as the round clock above.
   */
  private dutyStatus: DutyStatus | null = null;
  private dutyAt = 0;
  /** Offline only: the SAME PatrolDuty the server runs, not a second version. */
  private offlineDuty: PatrolDuty | null = null;
  /**
   * The ward, offline only. Online the server owns it — this exists so one
   * person can walk the medical loss path solo before a playtest.
   */
  private readonly offlinePatients = new PatientSystem();
  /** Only ticked offline; online the server owns the guards. */
  private readonly npcs = new NpcWorld();
  /** Latest NPC poses, from our own tick or from the server. */
  private npcSnapshots: NpcSnapshot[] = [];
  private readonly people: Perceivable[] = [];

  /** Rebuilt each step; kept as a field so a firefight never allocates. */
  private readonly actors: Actor[] = [];
  private readonly targets: CombatTarget[] = [];
  private readonly debugPoses: DebugPose[] = [];

  // --- networking (milestone 2) -------------------------------------------
  readonly net = new Connection();
  onNetStatus: (status: ConnectionStatus, detail: string, playerCount: number) => void = () => {};

  private readonly remotes = new Map<number, RemotePlayer>();
  private localId = 0;
  private stateTimer = 0;
  private pingTimer = 0;
  private pingSeq = 0;
  private pingSentAt = 0;
  private rttMs = 0;
  /**
   * Server clock we are drawing remote players at: the newest snapshot time
   * minus the interpolation delay, advanced locally between snapshots.
   */
  private renderTime = 0;
  private latestSnapshotTime = 0;
  private lastCorrection = '';

  constructor(
    canvas: HTMLCanvasElement,
    overlay: HTMLElement,
    debugElement: HTMLElement,
    hudElement: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x10120f);
    this.scene.fog = new THREE.Fog(0x10120f, 45, 110);

    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.input = new Input(canvas, overlay);
    this.debug = new DebugOverlay(this.scene, debugElement);
    this.hud = new HUD(hudElement);
    this.effects = new Effects(this.scene);
    this.audio = new Audio(this.scene);
    this.rig.camera.add(this.audio.listener);
    this.itemView = new ItemView(this.scene);
    this.npcView = new NpcView(this.scene);

    this.buildLights();
    this.scene.add(this.compound.group);
    this.scene.add(this.playerMesh.group);

    this.minimap = new Minimap();

    this.applyRole();
    const spawn = COMPOUND.spawnPoints[0];
    this.player.setPosition(spawn.x, spawn.y, spawn.z);
    this.seedOfflineItems();
    this.startOfflineRound();

    // The browser will not start audio until the player interacts; the click
    // that grabs pointer lock is that interaction.
    this.input.onPointerLock = () => this.audio.resume();

    // Proximity chat is off for this build (plan M6). The text line survives as
    // the telegram decipher input and nothing else types into it; the server's
    // `chat` case is still there, unreachable, so turning it back on is small.
    this.input.onTextSubmit = (text) => {
      this.hud.showChatInput(false);
      if (!this.puzzleActive) return;
      this.puzzleActive = false;
      const trimmed = (text ?? '').trim().slice(0, 200);
      if (!trimmed) return;
      if (this.net.connected) this.net.send({ t: 'puzzleAnswer', word: trimmed });
    };

    this.net.onMessage = this.onServerMessage;
    this.net.onStatus = (status, detail) => {
      if (status !== 'online') this.clearRemotes();
      this.onNetStatus(status, detail, this.remotes.size);
    };

    window.addEventListener('resize', this.onResize);
  }

  connect(url: string, name: string): void {
    this.net.connect(url, name, ROLE_ORDER[this.roleIndex]);
  }

  disconnect(): void {
    this.net.disconnect();
    // Back to the sandbox, and back to a round we run ourselves.
    this.startOfflineRound();
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xc9d4e0, 0x3a3a30, 1.6));

    const sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
    sun.position.set(30, 45, -20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -32;
    cam.right = 32;
    cam.top = 42;
    cam.bottom = -42;
    cam.near = 1;
    cam.far = 140;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.scene.add(sun.target);
    sun.target.position.set(0, 0, 4);
  }

  start(): void {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  private readonly frame = (now: number) => {
    const frameStart = performance.now();
    let delta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    delta = Math.min(delta, 0.25); // survive tab-out without teleporting

    // Mouse look runs on the render frame so it never feels stepped.
    const mouse = this.input.consumeMouseDelta();
    if (this.input.pointerLocked) this.rig.addMouse(mouse.dx, mouse.dy);

    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.fixedStep(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.weapons.update(delta);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - delta);
    this.moveLock = Math.max(0, this.moveLock - delta);
    this.handleCombatInput();
    this.handleInventoryKeys();
    this.handleDebugKeys();
    this.syncWeaponState();

    this.updateNetwork(delta);
    this.tickOfflineNpcs(delta);
    this.tickRound();
    this.tickDuty(delta);
    for (const bot of this.bots) bot.update(delta);
    this.effects.update(delta);
    this.itemView.update(delta);
    this.npcView.apply(this.npcSnapshots, this.searchingIds);
    this.npcView.update(delta);

    const feet = this.player.body.position;
    if (this.player.body.grounded && !this.wasGrounded) this.audio.landed(feet);
    this.wasGrounded = this.player.body.grounded;
    this.playerMesh.setPose(feet.x, feet.y, feet.z, this.player.facingYaw);
    // The controller turns the body towards where it is going, so this is
    // almost all forward — the backward and strafe clips show up during the
    // fraction of a second a hard reversal takes to turn through.
    const v = this.player.body.velocity;
    const local = localVelocity(v.x, v.z, this.player.facingYaw);
    this.playerMesh.update(delta, local.forward, local.right, this.player.body.grounded);
    this.rig.update(feet, delta, this.doors.solids());
    this.compound.update(delta);
    this.debug.updatePlayerVolume(feet.x, feet.y, feet.z);
    this.debug.updateDoors(this.doors);
    this.debug.updateHitboxes(this.collectDebugPoses());
    this.debug.updateVisionRays(this.npcSnapshots);
    this.updateZoneWarning();
    this.hud.setPrompt(this.promptText());
    this.hud.update(
      this.player.staminaFraction,
      this.player.exhausted,
      this.player.sprinting,
      this.maxHealth > 0 ? this.health / this.maxHealth : 0,
      this.weapons,
    );
    this.updateDebugText();

    // Minimap — egocentric, drawn each frame.
    this.minimap.draw(feet.x, feet.z, this.player.facingYaw);

    // Chat input display.
    if (this.input.textMode) {
      this.hud.showChatInput(true, this.input.textBuffer);
    }

    this.renderer.render(this.scene, this.rig.camera);
    this.input.endFrame();
    this.frameTimeMs = performance.now() - frameStart;
  };

  private fixedStep(dt: number): void {
    const canMove = this.input.pointerLocked && this.alive && this.moveLock <= 0;
    const axes = canMove ? this.input.moveAxes() : { x: 0, z: 0 };

    this.player.speedMultiplier = this.weapons.speedMultiplier;
    this.player.aimYaw = this.weapons.visible ? this.rig.yaw : null;
    this.rig.aiming = this.weapons.visible;
    this.player.step(
      dt,
      {
        x: axes.x,
        z: axes.z,
        sprint: canMove && this.input.sprint,
        jump: canMove && this.input.isDown('Space'),
      },
      this.rig.forward.clone(),
      this.rig.right.clone(),
      this.doors.solids(),
      this.collectActors(),
    );

    // Safety net while the map is still being edited.
    if (this.player.body.position.y < -10) this.unstick();
  }

  // --------------------------------------------------------------- combat

  /** Everyone you can bump into: live remote players and live debug bots. */
  private collectActors(): readonly Actor[] {
    this.actors.length = 0;
    for (const remote of this.remotes.values()) {
      if (!remote.alive) continue;
      this.actors.push({
        x: remote.pose.x,
        y: remote.pose.y,
        z: remote.pose.z,
        radius: GAME_CONFIG.player.radius,
        height: GAME_CONFIG.player.height,
      });
    }
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      this.actors.push({
        x: bot.x,
        y: bot.y,
        z: bot.z,
        radius: GAME_CONFIG.player.radius,
        height: GAME_CONFIG.player.height,
      });
    }
    for (const npc of this.npcSnapshots) {
      if (!npc.alive) continue;
      this.actors.push({
        x: npc.x,
        y: npc.y,
        z: npc.z,
        radius: GAME_CONFIG.player.radius,
        height: GAME_CONFIG.player.height,
      });
    }
    return this.actors;
  }

  /** Everything shootable, for the client's own tracer prediction. */
  private collectTargets(): readonly CombatTarget[] {
    this.targets.length = 0;
    for (const remote of this.remotes.values()) this.targets.push(remote.target);
    for (const bot of this.bots) this.targets.push(bot.target);
    for (const npc of this.npcSnapshots) {
      this.targets.push({ id: npc.id, x: npc.x, y: npc.y, z: npc.z, yaw: npc.yaw, alive: npc.alive });
    }
    return this.targets;
  }

  private collectDebugPoses(): readonly DebugPose[] {
    this.debugPoses.length = 0;
    const feet = this.player.body.position;
    this.debugPoses.push({ x: feet.x, y: feet.y, z: feet.z, yaw: this.player.facingYaw });
    for (const remote of this.remotes.values()) this.debugPoses.push({ ...remote.pose });
    for (const bot of this.bots) {
      this.debugPoses.push({ x: bot.x, y: bot.y, z: bot.z, yaw: bot.yaw });
    }
    for (const npc of this.npcSnapshots) {
      if (!npc.alive) continue;
      this.debugPoses.push({ x: npc.x, y: npc.y, z: npc.z, yaw: npc.yaw });
    }
    return this.debugPoses;
  }

  private handleCombatInput(): void {
    if (!this.input.pointerLocked) return;

    if (!this.alive) {
      // R is the only control that means anything to a corpse.
      this.discardMenu = null;
      if (this.input.wasPressed('KeyR')) this.requestRespawn();
      return;
    }

    // The discard menu takes over the keyboard while it is open. It is a line of
    // text on the prompt, not a real menu: pointer lock is never released, so a
    // guard walking in on you mid-decision is still your problem.
    if (this.discardMenu) {
      if (this.input.wasPressed('KeyG') || this.input.wasPressed('Escape')) {
        this.discardMenu = null;
        return;
      }
      for (let i = 0; i < this.discardMenu.length; i++) {
        if (this.input.wasPressed(`Digit${i + 1}`)) {
          this.dropWeapon(this.discardMenu[i]);
          this.discardMenu = null;
          return;
        }
      }
      return;
    }

    // A search pins both parties in place for as long as the officer holds them
    // (CLAUDE.md §16). It takes over the keyboard while it lasts — pointer lock
    // is never released, so the compound goes on happening around two people
    // who are standing perfectly still in the middle of it.
    if (this.activeSearch) {
      this.moveLock = Math.max(this.moveLock, 0.2);
      const items = this.activeSearch.items;
      // Only the officer has a list, and only the officer can end it early.
      if (items) {
        if (this.input.wasPressed('KeyE')) this.net.send({ t: 'searchRelease' });
        for (let i = 0; i < items.length && i < 9; i++) {
          if (!this.input.wasPressed(`Digit${i + 1}`)) continue;
          this.net.send({ t: 'confiscate', item: items[i]! });
          break;
        }
      }
      return;
    }

    // [F] search whoever is standing in front of you.
    if (this.input.wasPressed('KeyF')) this.handleSearchKey();

    // E held near a container = hold-to-search. E pressed elsewhere = door/item.
    this.tickContainerSearch();
    if (this.input.wasPressed('KeyE') && !this.searchTarget) this.handleUseKey();
    // G throws away what you are holding. With nothing drawn it asks which of
    // the things in your bag you meant. Suppressed while inventory is open so
    // one keypress cannot both open the discard menu and drop the selected item.
    if (this.input.wasPressed('KeyG') && !this.hud.isInventoryOpen()) this.handleDiscardKey();
    // Only animate a reload that actually started: pressing R on a full
    // magazine must not make the character mime one in front of a guard.
    if (this.input.wasPressed('KeyR') && this.weapons.startReload()) {
      this.playerMesh.playReload();
    }

    // Right click is the single most consequential control in the game: it is
    // the difference between a clerk walking down a corridor and a clerk a
    // guard is about to shoot. Nothing else may draw a weapon for you.
    // Suppressed while stunned: a stun must be a real freeze.
    if (this.input.mousePressed(MOUSE_RIGHT) && this.moveLock <= 0) {
      const result = this.weapons.toggleBrandish();
      if (result === 'refused') this.hud.showAlert('Cannot conceal a rifle — [G] to discard');
    }

    // Scroll picks WHICH weapon without changing whether it is on show.
    // When the inventory is open the wheel scrolls the selection instead.
    const wheel = this.input.consumeWheel();
    if (wheel !== 0) {
      if (this.hud.isInventoryOpen()) this.hud.selectInventory(wheel > 0 ? 1 : -1);
      else this.weapons.cycle(wheel);
    }

    // One click, one shot. The rifle is bolt-action and the pistol is not worth
    // making automatic; holding the button would only hide the fire interval.
    const fireHeld = this.input.mouseDown(MOUSE_LEFT);
    if (!fireHeld) return;

    // Melee is decided BEFORE the canFire() check: a drawn but empty/reloading
    // weapon must not silently eat the click. Check visibility first, not canFire.
    if (!this.weapons.visible) {
      if (this.input.mousePressed(MOUSE_LEFT)) this.strike();
    } else if (this.weapons.canFire()) {
      this.fire();
    }
  }
  // ---------------------------------------------------------------- items

  /** Offline there is no server to place the hidden pistols, so we do it. */
  private seedOfflineItems(): void {
    const spots = [...HIDDEN_PISTOL_SPOTS].sort(() => Math.random() - 0.5);
    for (const spot of spots.slice(0, HIDDEN_PISTOL_COUNT)) {
      this.itemView.add(this.items.spawn('pistol', spot.x, spot.y, spot.z));
    }
  }

  /**
   * The item at your feet, and whether you may actually have it. A rifle is a
   * metre of wood and steel: only the Security Officer can pick one up, and the
   * prompt says so rather than silently doing nothing (item 3).
   */
  private reachableItem(): { id: number; item: ItemId; allowed: boolean } | null {
    const feet = this.player.body.position;
    const ground = this.items.nearest(feet.x, feet.z);
    if (!ground) return null;
    // Already carrying one of this item.
    if (isWeaponItem(ground.item) && this.weapons.owns(ground.item)) return null;
    const allowed = !isWeaponItem(ground.item) || canCarry(this.player.stats.id, ground.item);
    return { id: ground.id, item: ground.item, allowed };
  }

  /**
   * E takes what is at your feet — it never draws it — or works the nearest
   * door. The item wins when both are in reach: bending down for a pistol is
   * the more specific intent, and doors do not go anywhere.
   */
  private handleUseKey(): void {
    const item = this.reachableItem();
    if (item) {
      if (item.allowed) this.pickUp(item.id, item.item);
      return;
    }
    const door = this.reachableDoor();
    if (door) this.toggleDoor(door.id);
  }

  /** The door you could put a hand on, if any. */
  private reachableDoor(): DoorDef | null {
    const feet = this.player.body.position;
    return this.doors.nearest(feet.x, feet.z);
  }

  private toggleDoor(id: number): void {
    if (this.net.connected) {
      // A request. The server checks we are really standing there and answers
      // with a `doors` message; nothing moves on our screen until it does.
      this.net.send({ t: 'door', id });
      return;
    }
    this.doors.toggle(id);
    this.compound.syncDoors(this.doors);
    // Offline: check access after toggling so the door opens (reaction is the consequence).
    const def = doorById(id);
    if (def && !doorPermits(def, this.player.stats.id, this.weapons.visible ? (this.weapons.held ?? null) : null)) {
      this.npcs.reportViolation(this.localId, { x: def.x, z: def.z });
    }
  }

  /**
   * G throws a weapon away. With one in your hands there is nothing to ask, and
   * you should not be reading a menu with a guard walking in; with your hands
   * empty and more than one thing in the bag, it asks which.
   */
  private handleDiscardKey(): void {
    if (this.weapons.visible && this.weapons.held) {
      this.dropWeapon(this.weapons.held);
      return;
    }
    const kit = this.weapons.inventory;
    if (kit.length === 0) return;
    if (kit.length === 1) {
      this.dropWeapon(kit[0]);
      return;
    }
    this.discardMenu = kit;
  }
  /**
   * Ask the server to search whoever is nearest (CLAUDE.md §16).
   *
   * The target is only ever an id. A player and an NPC are reached the same
   * way, refused the same way and produce the same shaped answer — an officer
   * who could tell from the interface which of the guards in this corridor were
   * people would have broken the disguise the whole roster is built on.
   */
  private handleSearchKey(): void {
    if (!this.net.connected) {
      this.hud.showAlert('Searching requires a server connection.');
      return;
    }
    const target = this.searchableNear();
    if (target) this.net.send({ t: 'searchStart', target: target.id });
  }

  /** The nearest live character within arm's reach, player or NPC alike. */
  private searchableNear(): { id: number; label: string } | null {
    if (this.player.stats.id !== 'security' || !this.net.connected) return null;
    const feet = this.player.body.position;
    let best: { id: number; label: string } | null = null;
    let bestDist: number = GAME_CONFIG.search.reach;

    for (const remote of this.remotes.values()) {
      if (!remote.alive) continue;
      const d = Math.hypot(remote.pose.x - feet.x, remote.pose.z - feet.z);
      if (d >= bestDist) continue;
      bestDist = d;
      best = { id: remote.info.id, label: remote.info.name };
    }
    for (const npc of this.npcSnapshots) {
      // The General is not frisked and a patient in a bed cannot stand up.
      if (!npc.alive || npc.kind === 'general' || npc.kind === 'patient') continue;
      const d = Math.hypot(npc.x - feet.x, npc.z - feet.z);
      if (d >= bestDist) continue;
      bestDist = d;
      best = { id: npc.id, label: npc.label };
    }
    return best;
  }

  private pickUp(id: number, itemId: ItemId): void {
    // Played on the request, not the confirmation: if the server refuses because
    // somebody beat us to it, a stray click is a far smaller cost than 60 ms of
    // dead air on every successful pickup.
    this.audio.pickup(this.player.body.position);

    if (this.net.connected) {
      // The server arbitrates: two players diving for the same pistol must not
      // both come up holding one. It answers with itemRemoved + inventory.
      this.net.send({ t: 'pickup', item: id });
      return;
    }
    this.items.remove(id);
    this.itemView.remove(id);
    if (isWeaponItem(itemId)) {
      this.weapons.give(itemId);
      // Taking a weapon should not put it in your hand in front of a guard.
      this.weapons.conceal();
    }
  }

  private dropWeapon(weapon: WeaponId): void {
    if (this.net.connected) {
      this.net.send({ t: 'drop', item: weapon });
      return;
    }
    const feet = this.player.body.position;
    this.weapons.remove(weapon);
    this.itemView.add(
      this.items.dropInFront(weapon, feet.x, feet.y, feet.z, this.player.facingYaw),
    );
  }

  private promptText(): string {
    if (!this.alive) return '';

    // Both sides of a search see a line, and they are deliberately different:
    // the officer is reading a list nobody else will ever see.
    const search = this.activeSearch;
    if (search) {
      const items = search.items;
      if (!items) return 'YOU ARE BEING SEARCHED';
      if (items.length === 0) return 'NOTHING ON HIM   ·   [E] release';
      const rows = items.slice(0, 9).map((id, i) => `[${i + 1}] ${ITEMS[id].name}`).join('   ');
      return `${rows}   ·   [E] release`;
    }

    if (this.discardMenu) {
      const choices = this.discardMenu
        .map((id, i) => `[${i + 1}] ${WEAPONS[id].name}`)
        .join('   ');
      return `DISCARD:  ${choices}   ·   [G] cancel`;
    }

    const frisk = this.searchableNear();
    if (frisk) return `[F]  search ${frisk.label}`;

    const item = this.reachableItem();
    if (item) {
      const name = ITEMS[item.item].name;
      return item.allowed
        ? `[E]  pick up ${name}`
        : `${name} — only the Security Officer may carry this`;
    }

    // Container nearby?
    const feet2 = this.player.body.position;
    const container = CONTAINERS.find((c) => {
      const dx = c.x - feet2.x;
      const dz = c.z - feet2.z;
      return Math.sqrt(dx * dx + dz * dz) <= GAME_CONFIG.world.containerReach;
    });
    if (container) {
      return `[E hold]  search ${container.label}`;
    }

    const door = this.reachableDoor();
    if (door) {
      const verb = this.doors.isOpen(door.id) ? 'close' : 'open';
      const visWep = this.weapons.visible ? (this.weapons.held ?? null) : null;
      const permitted = doorPermits(door, this.player.stats.id, visWep);
      const warning = permitted ? '' : ' — RESTRICTED, GUARDS WILL FIRE';
      return `[E]  ${verb} the ${door.label} door${warning}`;
    }

    const held = this.weapons.held;
    if (!held) return '';
    if (this.weapons.visible) return `[G]  throw away ${WEAPONS[held].name}`;
    return this.weapons.inventory.length > 1
      ? `[RMB] draw ${WEAPONS[held].name}   ·   [scroll] switch   ·   [G] discard`
      : `[RMB] draw ${WEAPONS[held].name}   ·   [G] discard`;
  }

  /**
   * Standing somewhere you are not allowed to be is the one thing in this game
   * that gets you shot without a warning, so being told once, on the way in, is
   * the difference between a rule and an ambush (CLAUDE.md §26).
   */
  private updateZoneWarning(): void {
    const feet = this.player.body.position;
    const zone = this.alive ? restrictedZoneAt(feet.x, feet.z) : null;
    const banned = zone && !zone.allow.includes(this.player.stats.id) ? zone.id : null;
    if (banned === this.lastZoneWarning) return;
    this.lastZoneWarning = banned;
    if (!zone || !banned) return;
    this.hud.showAlert(
      zone.response === 'shoot'
        ? `${zone.label} — GUARDS WILL FIRE ON SIGHT`
        : `${zone.label} — TURN BACK`,
    );
  }
  // ----------------------------------------------------------------- guards

  // ----------------------------------------------------------------- the round

  /**
   * Drives the clock, and offline decides the round as well.
   *
   * The solo round is deliberately the thin version of `RoundSystem`: you are a
   * loyalist, the General is the whole game, and the clock running out means he
   * survived. It exists so one person can walk both win paths before a playtest
   * — it is not, and should not become, a second implementation of the rules.
   */
  private tickRound(): void {
    if (!this.net.connected && this.roundPhase === 'active') {
      if (!this.npcs.generalAlive) {
        this.endOfflineRound('infiltrator', 'The General is dead.');
      } else if (this.offlinePatients.deadCount >= roundCfg.patientsLostToLose) {
        this.endOfflineRound('infiltrator', 'The medical ward was lost.');
      } else if (performance.now() >= this.roundEndsAt) {
        this.endOfflineRound('loyalist', 'The General survived the day.');
      }
    }

    const left = this.roundEndsAt > 0 ? (this.roundEndsAt - performance.now()) / 1000 : 0;
    this.hud.setRound(this.roundPhase, left, this.roundPlayers);
  }

  /**
   * The patrol line (CLAUDE.md §15).
   *
   * Offline this runs the real `PatrolDuty` against your own position, so one
   * person can check the whole mechanic — walk to the room, stand there, watch
   * it complete; ignore it, watch search switch off — without a second machine.
   * Online the server owns it and this only advances the clock between messages.
   */
  private tickDuty(dt: number): void {
    const now = performance.now();

    if (this.net.connected) {
      // The server took over; drop the solo one rather than run two.
      if (this.offlineDuty) {
        this.offlineDuty = null;
        this.dutyStatus = null;
      }
    } else {
      const officer = this.player.stats.id === 'security' && this.roundPhase === 'active';
      if (officer && !this.offlineDuty) {
        this.offlineDuty = new PatrolDuty();
        this.offlineDuty.start(now);
      } else if (!officer && this.offlineDuty) {
        this.offlineDuty = null;
        this.dutyStatus = null;
      }

      if (this.offlineDuty) {
        const feet = this.player.body.position;
        this.offlineDuty.tick(feet.x, feet.z, now, dt * 1000);
        this.dutyStatus = this.offlineDuty.status(now);
        this.dutyAt = now;
      }
    }

    if (!this.dutyStatus) {
      this.hud.setDuty(null);
      return;
    }

    const elapsed = (now - this.dutyAt) / 1000;
    this.hud.setDuty({
      ...this.dutyStatus,
      secondsLeft: this.dutyStatus.secondsLeft - elapsed,
      // Dwell only advances if we were already standing still when told; the
      // next message either completes it or resets it to zero.
      dwell: this.dutyStatus.dwell > 0 ? this.dutyStatus.dwell + elapsed : 0,
    });
  }

  /** Offline only; online the server sends `roundOver` and we just show it. */
  private endOfflineRound(winner: Faction, reason: string): void {
    this.roundPhase = 'over';
    this.roundEndsAt = performance.now() + roundCfg.intermissionSeconds * 1000;
    this.hud.showResult({
      t: 'roundOver',
      winner,
      reason,
      reveal: [
        {
          id: this.localId,
          name: 'you',
          role: this.player.stats.id,
          faction: this.faction ?? 'loyalist',
        },
      ],
    });
  }

  /** A solo round starts the moment you drop into the compound alone. */
  private startOfflineRound(): void {
    // One id space: the ward's patients ARE the bodies lying in it, so the
    // solo ward is seeded from the NPC world exactly as the server's is.
    this.offlinePatients.reset(this.npcs.patientIds);
    this.roundPhase = 'active';
    this.roundEndsAt = performance.now() + roundCfg.durationSeconds * 1000;
    this.roundPlayers = 1;
    this.faction = 'loyalist';
    this.hud.setFaction(this.faction);
    this.hud.hideResult();
  }

  /**
   * Full round restart for offline solo mode. Mirrors what `GameServer.startRound`
   * does online so F8 works the same either way (plan §1).
   */
  private resetOfflineWorld(): void {
    // Guards and General back to their posts, grudges cleared.
    this.npcs.reset();
    this.npcSnapshots = this.npcs.snapshots();

    // Items: sweep and reseed.
    this.items.clear();
    this.itemView.reset([]);
    this.seedOfflineItems();

    // Doors: shut them all.
    this.doors.setAll([]);
    this.compound.syncDoors(this.doors);

    // Player kit: restore role's starting loadout.
    const role = ROLE_ORDER[this.roleIndex];
    this.weapons.clear();
    for (const weapon of startingWeapons(role)) this.weapons.give(weapon);
    if (!canBrandish(role, 'pistol')) this.weapons.conceal();

    // Vitals.
    this.health = this.maxHealth;
    this.moveLock = 0;
    this.meleeCooldown = 0;
    this.activeSearch = null;
    this.searchingIds.clear();
    this.hud.hideReport();
    this.setAlive(true);
    this.unstick();

    // Bots.
    for (const bot of this.bots) bot.reset();

    // Duty.
    this.offlineDuty = null;
    this.dutyStatus = null;

    // Kick off the new round (sets roundPhase = 'active', hides the result banner).
    this.startOfflineRound();
  }

  /**
   * Solo mode runs the SAME guard brain the server runs, so the mandatory §37
   * guard test can be done by one person with no second machine. Online this
   * does nothing — guard state arrives in snapshots.
   */
  /**
   * The solo ward, and the bridge between its two halves — the same
   * reconciliation `GameServer.tickPatients` does, for the same reason: a
   * patient must never be dead in one system and alive in the other.
   */
  private tickOfflinePatients(dt: number): void {
    for (const patient of this.offlinePatients.all) {
      if (patient.status === 'dead') continue;
      if (this.npcs.info(patient.id)?.alive !== false) continue;
      if (this.offlinePatients.kill(patient.id, 'gunfire')) {
        this.hud.showAlert('A PATIENT HAS BEEN SHOT IN THE MEDICAL WARD');
      }
    }
    const { deaths } = this.offlinePatients.tick(dt);
    for (const id of deaths) {
      // Neglect is not an attack: the body lies down and no guard is provoked.
      this.npcs.expire(id);
      this.hud.showAlert('A PATIENT HAS DIED IN THE MEDICAL WARD');
    }
  }

  private tickOfflineNpcs(dt: number): void {
    if (this.net.connected) return;

    this.people.length = 0;
    const feet = this.player.body.position;
    this.people.push({
      id: this.localId,
      x: feet.x,
      y: feet.y,
      z: feet.z,
      yaw: this.player.facingYaw,
      role: this.player.stats.id,
      alive: this.alive,
      weapon: this.weapons.publicWeapon,
    });
    for (const bot of this.bots) this.people.push(bot.perceivable);

    const doorVersionBefore = this.doors.version;
    const events = this.npcs.tick(
      dt,
      performance.now(),
      this.people,
      this.doors.solids(),
      this.doors,
      this.items,
    );
    if (this.doors.version !== doorVersionBefore) this.compound.syncDoors(this.doors);
    this.tickOfflinePatients(dt);
    this.npcSnapshots = this.npcs.snapshots();

    for (const ev of events) {
      if (ev.t === 'shout') {
        this.hearShout(ev.text, ev.x, ev.z, ev.cue);
        continue;
      }
      if (ev.t === 'shot') {
        this.effects.shot(ev.origin, ev.end, false);
        this.audio.gunshot(ev.weapon, ev.origin);
        // Guard shot may hit a corpse already on the floor.
        const gDx = ev.end.x - ev.origin.x;
        const gDy = ev.end.y - ev.origin.y;
        const gDz = ev.end.z - ev.origin.z;
        const gLen = Math.hypot(gDx, gDy, gDz) || 1;
        this.splashCorpseBlood(ev.origin, { x: gDx / gLen, y: gDy / gLen, z: gDz / gLen }, gLen);
        continue;
      }
      if (ev.t === 'took') {
        // Guard confiscated a dropped item — remove it from the floor view.
        this.items.remove(ev.itemId);
        this.itemView.remove(ev.itemId);
        continue;
      }
      if (ev.targetId === this.localId) {
        this.takeDamage(ev.damage);
        continue;
      }
      const bot = this.bots.find((b) => b.id === ev.targetId);
      bot?.applyDamage(ev.damage);
    }
  }

  /**
   * A guard's shout, heard only if you are close enough (CLAUDE.md §31). One
   * path for both the offline brain and the server's relay, so the voiceover
   * cannot end up wired to only half the game.
   */
  private hearShout(text: string, x: number, z: number, cue?: GuardVoiceCue): void {
    const feet = this.player.body.position;
    if (Math.hypot(feet.x - x, feet.z - z) > GAME_CONFIG.guards.shoutRadius) return;
    this.hud.showAlert(`GUARD: ${text}`);
    // The shout carries a position but no height — it came out of a man's head.
    if (cue) this.audio.guardVoice(cue, { x, y: 1.55, z });
  }

  /** Offline damage to the local player. Online, health is the server's alone. */
  private takeDamage(amount: number): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.hud.showHurt();
    if (this.health === 0) this.setAlive(false);
  }

  /**
   * Fire a hitscan shot (CLAUDE.md §12). The tracer you see is drawn immediately
   * for feel; the SERVER decides what was actually hit, and its verdict arrives
   * as a `hitmark`. In solo mode there is no server, so the same shared
   * resolution runs here against the debug bots.
   */
  private fire(): void {
    const weapon = this.weapons.consumeShot();
    if (!weapon) return;

    const origin = this.muzzle();
    const direction = this.aimDirection(origin, WEAPONS[weapon].spread);

    const outcome = resolveShot(
      origin,
      direction,
      weapon,
      this.collectTargets(),
      this.doors.solids(),
      this.localId,
    );
    this.effects.shot(origin, outcome.point, outcome.kind === 'hit');
    this.audio.gunshot(weapon, origin);
    // The pistol model animates its own slide; the rifle has no such clip and
    // this does nothing for it.
    this.playerMesh.playFire();
    this.splashCorpseBlood(origin, direction, WEAPONS[weapon].range);
    // Every guard who could have heard that walks over to look, hit or miss.
    // Online the server does this from the authoritative shot.
    if (!this.net.connected) {
      this.npcs.hearNoise(origin.x, origin.z, GAME_CONFIG.guards.gunshotHearRadius);
    }

    if (this.net.connected) {
      this.net.send({
        t: 'fire',
        weapon,
        ox: round(origin.x),
        oy: round(origin.y),
        oz: round(origin.z),
        dx: round(direction.x),
        dy: round(direction.y),
        dz: round(direction.z),
      });
      return;
    }

    // Solo: resolve it ourselves, against debug bots and the local NPC world.
    if (outcome.kind !== 'hit') return;
    const damage = damageFor(weapon, outcome.region);
    const feet = this.player.body.position;
    const killed = this.applyOfflineDamage(outcome.targetId, damage, { x: feet.x, z: feet.z });
    if (killed === null) return;
    this.hud.showHitmarker(killed);
    this.lastHitText = `${weapon} → ${outcome.region} ${damage} dmg${killed ? ' (KILL)' : ''}`;
  }

  /**
   * Offline damage to whatever we just hit. Returns whether it died, or null if
   * the id belongs to nothing we own — online, that is the server's business.
   */
  private applyOfflineDamage(
    targetId: number,
    damage: number,
    from?: { x: number; z: number },
  ): boolean | null {
    const bot = this.bots.find((b) => b.id === targetId);
    if (bot) return bot.applyDamage(damage);

    const before = this.npcSnapshots.find((n) => n.id === targetId);
    const result = this.npcs.applyDamage(targetId, damage, this.localId, from);
    if (!result) return null;
    // Shooting a guard is loud in the social sense too: the survivors come for
    // you, and that is exactly the risk the assassination is supposed to carry.
    this.npcSnapshots = this.npcs.snapshots();

    if (result.killed) {
      // A dead guard drops his issued rifle plus anything he confiscated.
      if (result.kind === 'guard' && before && result.drops.length > 0) {
        for (const item of this.items.spill(result.drops, before.x, before.y, before.z)) {
          this.itemView.add(item);
        }
      }
      if (result.kind === 'general') this.hud.showAlert('THE GENERAL IS DOWN');
    }
    return result.killed;
  }

  /**
   * Client-only: if the shot ray passes through a dead character's capsule,
   * grow their blood puddle. Purely visual — no server involvement.
   */
  private splashCorpseBlood(origin: Vec3, dir: Vec3, range: number): void {
    const tryHit = (cx: number, cy: number, cz: number): boolean => {
      // Closest point on the ray segment to the character's torso centre.
      const tx = cx - origin.x;
      const ty = cy + 0.85 - origin.y;
      const tz = cz - origin.z;
      const t = Math.max(0, Math.min(tx * dir.x + ty * dir.y + tz * dir.z, range));
      const px = origin.x + dir.x * t - cx;
      const py = origin.y + dir.y * t - (cy + 0.85);
      const pz = origin.z + dir.z * t - cz;
      if (Math.hypot(px, py, pz) >= 0.55) return false;
      this.effects.spurt({ x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t }, dir);
      return true;
    };

    for (const bot of this.bots) {
      if (bot.alive) continue;
      if (tryHit(bot.x, bot.y, bot.z)) { bot.addBlood(); return; }
    }
    for (const npc of this.npcSnapshots) {
      if (npc.alive) continue;
      if (tryHit(npc.x, npc.y, npc.z)) { this.npcView.addBlood(npc.id); return; }
    }
    for (const remote of this.remotes.values()) {
      if (remote.alive) continue;
      const p = remote.pose;
      if (tryHit(p.x, p.y, p.z)) { remote.addBlood(); return; }
    }
  }

  /** Unarmed strike — the option a player who never found a weapon still has. */
  private strike(): void {
    if (this.meleeCooldown > 0) return;
    this.meleeCooldown = combatCfg.melee.cooldown;
    this.moveLock = combatCfg.melee.attackLock;

    const yaw = this.player.facingYaw;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    this.playerMesh.playSwing();

    if (this.net.connected) {
      this.net.send({ t: 'melee', dx: round(dx), dz: round(dz) });
      return;
    }

    const feet = this.player.body.position;
    const hit = resolveMelee(
      { x: feet.x, y: feet.y + 1.2, z: feet.z },
      { x: dx, y: 0, z: dz },
      this.collectTargets(),
      this.doors.solids(),
      this.localId,
    );
    if (!hit) return;
    const damage = meleeDamageFor(this.player.stats.id);
    const killed = this.applyOfflineDamage(hit.id, damage, { x: feet.x, z: feet.z });
    if (killed === null) return;
    // Only a LANDED strike is heard, and barely — a miss is silent. Mirrors the
    // server's ordering in CombatSystem.melee, which returns before the noise.
    this.npcs.hearNoise(feet.x, feet.z, GAME_CONFIG.guards.meleeHearRadius);
    this.audio.punch({ x: hit.x, y: hit.y + 1.2, z: hit.z });
    this.hud.showHitmarker(killed);
    this.lastHitText = `melee → ${damage} dmg${killed ? ' (KILL)' : ''}`;
    if (!killed) {
      // Stagger the survivor in solo/offline mode too, so the behaviour shows
      // without a second machine.
      this.npcs.stun(hit.id, combatCfg.melee.stunDuration);
      this.npcView.getHit(hit.id, combatCfg.melee.stunDuration);
    }
  }

  /** Shot origin: the shooter's shoulder, close enough for the server's check. */
  private muzzle(): Vec3 {
    const feet = this.player.body.position;
    const right = this.rig.right;
    return {
      x: feet.x + right.x * 0.18,
      y: feet.y + GAME_CONFIG.player.eyeHeight - 0.1,
      z: feet.z + right.z * 0.18,
    };
  }

  /** Muzzle → crosshair, plus the weapon's own spread cone. */
  private aimDirection(origin: Vec3, spread: number): Vec3 {
    const focus = this.rig.focusPoint(
      120,
      this.doors.solids(),
      this.collectTargets(),
      this.localId,
    );
    let x = focus.x - origin.x;
    let y = focus.y - origin.y;
    let z = focus.z - origin.z;
    let length = Math.hypot(x, y, z);

    // A wall pressed against the camera can put the focus point behind us.
    if (length < 1) {
      const look = this.rig.look;
      x = look.x;
      y = look.y;
      z = look.z;
      length = 1;
    }
    x /= length;
    y /= length;
    z /= length;

    if (spread > 0) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * spread;
      // Any two vectors perpendicular to the aim will do for a symmetric cone.
      const up = Math.abs(y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      const rx = up.y * z - up.z * y;
      const ry = up.z * x - up.x * z;
      const rz = up.x * y - up.y * x;
      const rl = Math.hypot(rx, ry, rz) || 1;
      const ux = y * (rz / rl) - z * (ry / rl);
      const uy = z * (rx / rl) - x * (rz / rl);
      const uz = x * (ry / rl) - y * (rx / rl);

      x += ((rx / rl) * Math.cos(angle) + ux * Math.sin(angle)) * radius;
      y += ((ry / rl) * Math.cos(angle) + uy * Math.sin(angle)) * radius;
      z += ((rz / rl) * Math.cos(angle) + uz * Math.sin(angle)) * radius;
      const l2 = Math.hypot(x, y, z) || 1;
      x /= l2;
      y /= l2;
      z /= l2;
    }

    return { x, y, z };
  }

  /** Tell the server what our hands are visibly doing — and nothing more. */
  private syncWeaponState(): void {
    const shown = this.weapons.publicWeapon;
    this.playerMesh.setWeapon(shown);
    if (shown === this.lastSentWeapon) return;
    this.lastSentWeapon = shown;
    this.net.send({ t: 'weapon', weapon: shown });
  }

  private requestRespawn(): void {
    if (this.net.connected) {
      this.net.send({ t: 'respawn' });
      return;
    }
    this.setAlive(true);
    this.health = this.maxHealth;
    // Being shot settles the account with the guards who wanted you shot.
    this.npcs.forget(this.localId);
    this.unstick();
  }

  private setAlive(alive: boolean): void {
    if (this.alive === alive) return;
    this.alive = alive;
    this.playerMesh.setDead(!alive);
    if (!alive) this.deadSince = performance.now();
    this.hud.setDeath(!alive, alive ? '' : 'R to respawn');
  }

  // ------------------------------------------------------------- debug keys

  private handleInventoryKeys(): void {
    // The report takes the keyboard while it is open, the same way the discard
    // menu does: a digit denounces that character to the whole compound, which
    // is the single most consequential key in the game, so nothing else may be
    // listening at the same time.
    if (this.hud.isReportOpen()) {
      if (this.input.wasPressed('Escape')) {
        this.hud.hideReport();
        return;
      }
      for (let i = 0; i < this.reportCandidates.length && i < 9; i++) {
        if (!this.input.wasPressed(`Digit${i + 1}`)) continue;
        this.net.send({ t: 'broadcastReport', target: this.reportCandidates[i]!.id });
        this.hud.hideReport();
        return;
      }
      return;
    }

    // [P] request a telegram puzzle (Telegram Operator only, online)
    if (this.input.wasPressed('KeyP') && this.player.stats.id === 'telegram') {
      if (this.net.connected) this.net.send({ t: 'startPuzzle' });
      else this.hud.showAlert('Telegram puzzles require a server connection.');
    }

    if (this.input.wasPressed('KeyI') || this.input.wasPressed('Tab')) {
      this.hud.toggleInventory();
    }
    if (!this.hud.isInventoryOpen()) return;

    // ↑↓ or 1-9 to move the selection
    if (this.input.wasPressed('ArrowUp')) this.hud.selectInventory(-1);
    if (this.input.wasPressed('ArrowDown')) this.hud.selectInventory(1);
    for (let i = 1; i <= 9; i++) {
      if (this.input.wasPressed(`Digit${i}`)) this.hud.setSelected(i - 1);
    }

    // [U] use the selected item
    if (this.input.wasPressed('KeyU')) {
      const sel = this.hud.selectedItem();
      if (sel && sel !== 'pistol' && sel !== 'rifle') {
        if (this.net.connected) {
          this.net.send({ t: 'use', item: sel });
        } else {
          this.applyItemUseOffline(sel);
        }
      }
    }

    // [G] drop the selected item
    if (this.input.wasPressed('KeyG') && this.hud.isInventoryOpen()) {
      const sel = this.hud.selectedItem();
      if (sel) {
        if (isWeaponItem(sel)) this.dropWeapon(sel);
        else {
          if (this.net.connected) {
            this.net.send({ t: 'drop', item: sel });
          } else {
            const feet = this.player.body.position;
            this.fullInventory = this.fullInventory.filter((i) => i !== sel);
            this.hud.syncInventory(this.fullInventory);
            this.itemView.add(this.items.dropInFront(sel, feet.x, feet.y, feet.z, this.player.facingYaw));
          }
        }
      }
    }
  }

  private applyItemUseOffline(item: ItemId): void {
    if (item === 'medkit') {
      this.health = this.maxHealth;
      this.fullInventory = this.fullInventory.filter((i) => i !== item);
      this.hud.syncInventory(this.fullInventory);
    }
  }

  private tickContainerSearch(): void {
    const feet = this.player.body.position;
    const reach = GAME_CONFIG.world.containerReach;

    if (this.input.isDown('KeyE')) {
      // Bending down for a pistol is the more specific intent — if there is a
      // pickupable item in reach, let handleUseKey() claim E instead.
      if (this.reachableItem()) {
        if (this.searchTarget) {
          this.searchTarget = null;
          this.searchTimer = 0;
          this.hud.setSearchProgress(null);
        }
        return;
      }

      // Find nearest container in reach.
      const container = CONTAINERS.find((c) => {
        const dx = c.x - feet.x;
        const dz = c.z - feet.z;
        return Math.sqrt(dx * dx + dz * dz) <= reach;
      });

      if (container) {
        // If we just started targeting this container, initialise the timer.
        if (!this.searchTarget || this.searchTarget.id !== container.id) {
          this.searchTarget = { id: container.id, label: container.label, x: container.x, z: container.z };
          this.searchTimer = 0;
        }
        this.searchTimer += FIXED_STEP;
        const fraction = this.searchTimer / GAME_CONFIG.world.containerSearchSeconds;
        this.hud.setSearchProgress(fraction, `SEARCHING ${container.label.toUpperCase()}…`);

        if (this.searchTimer >= GAME_CONFIG.world.containerSearchSeconds) {
          // Search complete.
          this.hud.setSearchProgress(null);
          if (this.net.connected) {
            this.net.send({ t: 'openContainer', id: container.id });
          } else {
            this.hud.showAlert('(Nothing found — offline mode)');
          }
          this.searchTarget = null;
          this.searchTimer = 0;
        }
        return;
      }
    }

    // E released or no container in reach.
    if (this.searchTarget) {
      this.searchTarget = null;
      this.searchTimer = 0;
      this.hud.setSearchProgress(null);
    }
  }

  private handleDebugKeys(): void {
    if (this.input.wasPressed('F1')) this.debug.toggleColliders();
    if (this.input.wasPressed('F2')) this.debug.toggleHitboxes();
    if (this.input.wasPressed('F3')) this.debug.toggleVision();

    // F4 shows YOUR allegiance and nobody else's (CLAUDE.md §30, §38). It is a
    // toggle rather than a permanent HUD line for a reason that has nothing to
    // do with code: at a playtest people sit next to each other.
    if (this.input.wasPressed('F4')) {
      const shown = this.hud.toggleFaction();
      this.hud.showAlert(shown ? 'FACTION SHOWN' : 'FACTION HIDDEN');
    }

    if (this.input.wasPressed('F5')) {
      this.roleIndex = (this.roleIndex + 1) % ROLE_ORDER.length;
      this.applyRole();
      const role = ROLE_ORDER[this.roleIndex];
      this.net.setRole(role);
      this.net.send({ t: 'role', role });
    }

    if (this.input.wasPressed('F6')) this.weapons.give('pistol');
    if (this.input.wasPressed('F7')) this.weapons.give('rifle');

    if (this.input.wasPressed('F8')) {
      if (this.net.connected) this.net.send({ t: 'reset' });
      else this.resetOfflineWorld();
    }

    if (this.input.wasPressed('F9')) this.unstick();
    if (this.input.wasPressed('KeyB')) this.spawnBot();
    if (this.input.wasPressed('KeyN')) this.nearestBot()?.cycleRole(ROLE_ORDER);
    if (this.input.wasPressed('KeyV')) this.nearestBot()?.cycleWeapon();
    if (this.input.wasPressed('KeyM')) this.clearBots();
  }

  /** A stationary target 4 m in front of you, facing back at you. */
  private spawnBot(): void {
    const feet = this.player.body.position;
    const yaw = this.player.facingYaw;
    const x = feet.x - Math.sin(yaw) * 4;
    const z = feet.z - Math.cos(yaw) * 4;
    const bot = new DummyBot(this.nextBotId--, ROLE_ORDER[this.roleIndex], x, feet.y, z, yaw + Math.PI);
    this.bots.push(bot);
    this.scene.add(bot.group);
  }

  private clearBots(): void {
    for (const bot of this.bots) bot.dispose();
    this.bots.length = 0;
  }

  private nearestBot(): DummyBot | null {
    const feet = this.player.body.position;
    let best: DummyBot | null = null;
    let bestDistance = Infinity;
    for (const bot of this.bots) {
      const d = Math.hypot(bot.x - feet.x, bot.z - feet.z);
      if (d >= bestDistance) continue;
      best = bot;
      bestDistance = d;
    }
    return best;
  }

  private applyRole(): void {
    const role = ROLE_ORDER[this.roleIndex];
    this.player.setRole(role);
    this.playerMesh.setBodyColor(this.player.stats.bodyColor);
    this.playerMesh.setModel(role);
    this.hud.setRole(this.player.stats);
    this.weapons.setRole(role);

    // Max health is per role, so changing role has to reset it or the damage
    // rules stop meaning what they say. The server does the same on its side.
    this.maxHealth = this.player.stats.maxHealth;
    this.health = this.maxHealth;

    // Only the officer starts armed; everybody else has to find a pistol.
    this.weapons.clear();
    for (const weapon of startingWeapons(role)) this.weapons.give(weapon);
    if (!canBrandish(role, 'pistol')) this.weapons.conceal();
  }

  /**
   * Apply a server-assigned role to the local player without re-seeding their
   * inventory — the server sends an `inventory` message right after `role`, so
   * we leave weapons alone here and let `setInventory` handle them.
   */
  private setLocalRole(role: Role): void {
    this.roleIndex = ROLE_ORDER.indexOf(role);
    this.player.setRole(role);
    this.playerMesh.setBodyColor(this.player.stats.bodyColor);
    this.playerMesh.setModel(role);
    this.hud.setRole(this.player.stats);
    this.maxHealth = this.player.stats.maxHealth;
    this.weapons.setRole(role);
    // Guards spawn with the rifle visibly drawn — indistinguishable from NPC guards.
    const vis = startingVisibleWeapon(role);
    if (vis) this.weapons.brandishSpecific(vis);
    // Health is corrected by the server's `health` message that follows.
    this.net.setRole(role);
  }

  private unstick(): void {
    const spawn = COMPOUND.spawnPoints[0];
    this.player.setPosition(spawn.x, spawn.y, spawn.z);
    // Tell the server this discontinuity was deliberate, or its move check
    // will read the teleport as a speed hack and snap us back.
    this.net.send({ t: 'teleport', x: spawn.x, y: spawn.y, z: spawn.z });
  }

  // ------------------------------------------------------------- networking

  private updateNetwork(delta: number): void {
    if (this.net.connected) {
      this.stateTimer += delta;
      if (this.stateTimer >= STATE_INTERVAL) {
        this.stateTimer = 0;
        const p = this.player.body.position;
        this.net.send({
          t: 'state',
          x: round(p.x),
          y: round(p.y),
          z: round(p.z),
          yaw: round(this.player.facingYaw),
          grounded: this.player.body.grounded,
          sprinting: this.player.sprinting,
        });
      }

      this.pingTimer += delta;
      if (this.pingTimer >= PING_INTERVAL) {
        this.pingTimer = 0;
        this.pingSeq++;
        this.pingSentAt = performance.now();
        this.net.send({ t: 'ping', id: this.pingSeq });
      }
    }

    this.advanceRenderClock(delta);
    for (const remote of this.remotes.values()) remote.update(this.renderTime, delta);
  }

  /**
   * Keep the local render clock locked to the server's, running
   * `interpolationDelayMs` behind it. Small drift is eased out so remote motion
   * never visibly speeds up or stutters; a large gap (tab-out, a stall) is
   * snapped, because easing across seconds would look like everyone sprinting.
   */
  private advanceRenderClock(delta: number): void {
    if (this.latestSnapshotTime === 0) return;
    this.renderTime += delta * 1000;

    const target = this.latestSnapshotTime - NET_CONFIG.interpolationDelayMs;
    const drift = target - this.renderTime;
    if (Math.abs(drift) > 500) this.renderTime = target;
    else this.renderTime += drift * Math.min(1, delta * 2);
  }

  private readonly onServerMessage = (msg: ServerMessage): void => {
    switch (msg.t) {
      case 'welcome': {
        this.localId = msg.id;
        // The server picked our spawn, so go there. Without this our first
        // position report is metres from where the server thinks we are and
        // the move check correctly refuses it.
        this.player.setPosition(msg.spawn.x, msg.spawn.y, msg.spawn.z);
        this.health = msg.health;
        this.maxHealth = msg.maxHealth;
        this.setAlive(true);
        this.clearRemotes();
        for (const player of msg.players) this.addRemote(player);

        // Apply the server's role BEFORE setInventory: applyRole clears weapons
        // and would wipe the inventory the server just told us about.
        this.setLocalRole(msg.you.role);

        // The offline compound we seeded has different NPC ids than the server's
        // round roster — clear stale actors so they are rebuilt with the right
        // models. npcSnapshots is repopulated by the first 'snapshot' message.
        this.npcView.clear();
        this.npcSnapshots = [];

        // The offline field we seeded is not the server's; replace it wholesale
        // so our ids are the server's ids and `pickup` names the right thing.
        this.items.clear();
        for (const item of msg.items) this.items.insert(item);
        this.itemView.reset(msg.items);
        this.fullInventory = msg.inventory;
        this.weapons.setInventory(msg.inventory);
        this.hud.syncInventory(msg.inventory);

        // Likewise the doors: whatever we had open solo is not what this
        // compound looks like now.
        this.doors.setAll(msg.doors);
        this.compound.syncDoors(this.doors);

        // Our weapon state predates the connection; re-announce it.
        this.lastSentWeapon = null;
        this.onNetStatus('online', '', this.remotes.size);
        break;
      }

      case 'joined': {
        this.addRemote(msg.player);
        this.onNetStatus('online', '', this.remotes.size);
        break;
      }

      case 'left': {
        this.remotes.get(msg.id)?.dispose();
        this.remotes.delete(msg.id);
        this.onNetStatus('online', '', this.remotes.size);
        break;
      }

      case 'role': {
        if (msg.id === this.localId) {
          this.setLocalRole(msg.role);
        } else {
          this.remotes.get(msg.id)?.setRole(msg.role);
        }
        break;
      }

      case 'snapshot': {
        this.latestSnapshotTime = msg.time;
        // First snapshot: start the clock rather than easing in from zero.
        if (this.renderTime === 0) {
          this.renderTime = msg.time - NET_CONFIG.interpolationDelayMs;
        }
        for (const snap of msg.players) this.remotes.get(snap.id)?.push(msg.time, snap);
        // Guards are the server's; ours stay idle for the whole session.
        this.npcSnapshots = msg.npcs;
        break;
      }

      case 'inventory': {
        this.fullInventory = msg.items;
        this.weapons.setInventory(msg.items);
        this.hud.syncInventory(msg.items);
        if (this.drawWeaponOnNextInventory) {
          this.drawWeaponOnNextInventory = false;
          const vis = startingVisibleWeapon(this.player.stats.id);
          if (vis) this.weapons.brandishSpecific(vis);
        }
        break;
      }

      case 'itemAdded': {
        this.items.insert(msg.item);
        this.itemView.add(msg.item);
        break;
      }

      case 'itemRemoved': {
        this.items.remove(msg.id);
        this.itemView.remove(msg.id);
        break;
      }

      case 'doors': {
        this.doors.setAll(msg.open);
        this.compound.syncDoors(this.doors);
        break;
      }

      case 'itemsReset': {
        this.items.clear();
        for (const item of msg.items) this.items.insert(item);
        this.itemView.reset(msg.items);
        break;
      }

      case 'round': {
        this.roundPhase = msg.phase;
        // Counted down on OUR clock from here: see the note on `secondsLeft`.
        this.roundEndsAt = msg.secondsLeft > 0 ? performance.now() + msg.secondsLeft * 1000 : 0;
        this.roundPlayers = msg.players;
        // Absent means the server is not telling us — in the lobby, or because
        // we joined mid-round and were not dealt in. Either way we know nothing.
        this.faction = msg.you?.faction ?? null;
        this.hud.setFaction(this.faction);
        if (msg.phase === 'active') this.hud.hideResult();
        break;
      }

      case 'duty': {
        this.dutyStatus = msg.duty;
        this.dutyAt = performance.now();
        break;
      }

      case 'roundOver': {
        this.hud.showResult(msg);
        break;
      }

      case 'shout': {
        this.hearShout(msg.text, msg.x, msg.z, msg.cue);
        break;
      }

      case 'correction': {
        // Hybrid authority: the server refused where we said we were.
        this.player.setPosition(msg.x, msg.y, msg.z);
        this.lastCorrection = msg.reason;
        break;
      }

      case 'health': {
        // Only ever OUR health; the server never sends anyone else's.
        const hurt = msg.health < this.health;
        this.health = msg.health;
        this.maxHealth = msg.maxHealth;
        if (hurt) this.hud.showHurt();
        break;
      }

      case 'shot': {
        // Our own tracer and report were already produced the instant we clicked.
        if (msg.id === this.localId) break;
        const shotOrigin = { x: msg.ox, y: msg.oy, z: msg.oz };
        const shotEnd = { x: msg.hx, y: msg.hy, z: msg.hz };
        this.effects.shot(shotOrigin, shotEnd, false);
        this.audio.gunshot(msg.weapon, shotOrigin);
        // Show blood on corpses hit by other players too.
        const shotDx = shotEnd.x - shotOrigin.x;
        const shotDy = shotEnd.y - shotOrigin.y;
        const shotDz = shotEnd.z - shotOrigin.z;
        const shotLen = Math.hypot(shotDx, shotDy, shotDz) || 1;
        this.splashCorpseBlood(shotOrigin, { x: shotDx / shotLen, y: shotDy / shotLen, z: shotDz / shotLen }, shotLen);
        break;
      }

      case 'swing': {
        if (msg.id !== this.localId) this.remotes.get(msg.id)?.swing();
        break;
      }

      case 'struck': {
        if (msg.id === this.localId) {
          this.moveLock = combatCfg.melee.stunDuration;
          this.playerMesh.playGetHit(combatCfg.melee.stunDuration);
        } else {
          const remote = this.remotes.get(msg.id);
          if (remote) {
            remote.getHit(combatCfg.melee.stunDuration);
          } else {
            this.npcView.getHit(msg.id, combatCfg.melee.stunDuration);
          }
        }
        break;
      }

      case 'hitmark': {
        this.hud.showHitmarker(msg.lethal);
        this.lastHitText = `${msg.region}${msg.lethal ? ' (KILL)' : ''}`;
        // The server confirmed the punch landed; only then is there a thud.
        if (msg.region === 'melee') this.audio.punch(this.player.body.position);
        break;
      }

      case 'death': {
        if (msg.id === this.localId) {
          this.setAlive(false);
          this.health = 0;
        } else {
          const remote = this.remotes.get(msg.id);
          if (remote) remote.setAlive(false);
        }
        break;
      }

      case 'spawned': {
        if (msg.id === this.localId) {
          this.player.setPosition(msg.x, msg.y, msg.z);
          this.setAlive(true);
          // Signal the next inventory message to brandish the role's starting weapon.
          if (startingVisibleWeapon(this.player.stats.id)) this.drawWeaponOnNextInventory = true;
        }
        break;
      }

      case 'pong': {
        if (msg.id === this.pingSeq) this.rttMs = performance.now() - this.pingSentAt;
        break;
      }

      case 'reject': {
        this.lastCorrection = msg.reason;
        break;
      }

      case 'alert': {
        this.hud.showAlert(msg.text);
        break;
      }

      case 'container': {
        if (msg.items.length === 0) {
          this.hud.showAlert('Container is empty.');
        } else {
          this.hud.showAlert(`Added to bag: ${msg.items.map((id) => ITEMS[id].name).join(', ')}`);
        }
        // Inventory updated via the separate 'inventory' message; any duplicate
        // items that couldn't fit are on the floor via 'itemsReset'.
        break;
      }

      case 'chatMsg': {
        this.hud.addChatLine(msg.name, msg.text, msg.channel);
        break;
      }

      case 'noise': {
        this.minimap.addNoise(msg.x, msg.z, msg.kind);
        break;
      }

      case 'patients': {
        // Public patient status update — could update a future ward UI.
        break;
      }

      case 'examine': {
        this.hud.showAlert(`Patient needs: ${msg.need.toUpperCase()}`);
        break;
      }

      case 'announce': {
        this.hud.showAlert(msg.text);
        break;
      }

      case 'puzzle': {
        // The decipher input opens itself. It used to hang off the chat key,
        // which no longer exists (plan M6).
        this.puzzleActive = true;
        this.input.enterTextMode();
        this.hud.showChatInput(true, '', `DECIPHER ${msg.scrambled}`);
        break;
      }

      case 'search': {
        this.searchingIds.delete(msg.officer);
        this.searchingIds.delete(msg.target);
        this.remotes.get(msg.officer)?.setSearching(false);
        this.remotes.get(msg.target)?.setSearching(false);
        if (msg.phase === 'end') {
          if (msg.officer === this.localId || msg.target === this.localId) {
            this.activeSearch = null;
          }
          break;
        }
        this.searchingIds.add(msg.officer);
        this.searchingIds.add(msg.target);
        this.remotes.get(msg.officer)?.setSearching(true);
        this.remotes.get(msg.target)?.setSearching(true);
        if (msg.officer === this.localId || msg.target === this.localId) {
          // `items` rides on the officer's copy and nobody else's — including
          // the copy sent to the person being searched.
          this.activeSearch = { officer: msg.officer, target: msg.target, items: msg.items ?? null };
        }
        break;
      }

      case 'report': {
        this.reportCandidates = msg.candidates;
        const named = msg.candidates.find((c) => c.id === msg.truth);
        this.hud.showReport(named?.label ?? 'SOMEONE IN THIS COMPOUND', msg.candidates);
        break;
      }

      case 'flagged': {
        // The announcement arrives separately, as its own compound-wide line.
        // This is only the tag, and it stays up for the rest of the round.
        this.remotes.get(msg.id)?.setFlagged();
        break;
      }
    }
  };

  private addRemote(info: PlayerPublic): void {
    if (info.id === this.localId || this.remotes.has(info.id)) return;
    const remote = new RemotePlayer(info);
    this.remotes.set(info.id, remote);
    this.scene.add(remote.group);
  }

  private clearRemotes(): void {
    for (const remote of this.remotes.values()) remote.dispose();
    this.remotes.clear();
    this.latestSnapshotTime = 0;
    this.renderTime = 0;
  }

  private updateDebugText(): void {
    const p = this.player.body.position;
    const room = COMPOUND.rooms.find(
      (r) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ,
    );

    const s = this.player.stats;
    const held = this.weapons.held;
    const legal = held ? (canBrandish(s.id, held) ? 'authorised' : 'ILLEGAL') : '—';

    this.debug.setText([
      `room     ${room?.name ?? '—'}`,
      `pos      ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}`,
      `role     ${s.name}  (walk ${s.walkSpeed} / sprint ${s.sprintSpeed} / melee ${s.meleeDamage})`,
      `health   ${this.health} / ${this.maxHealth}${this.alive ? '' : '   DEAD'}`,
      `weapon   ${this.weapons.state}${held ? `  ${held}  ${legal}` : ''}`,
      `speed    ${this.player.speed.toFixed(2)} m/s`,
      `stamina  ${this.player.stamina.toFixed(1)} / ${s.stamina.max}${this.player.exhausted ? '  EXHAUSTED' : ''}`,
      `grounded ${this.player.body.grounded ? 'yes' : 'no '}   vy ${this.player.body.velocity.y.toFixed(2)}`,
      `bots     ${this.bots.length}   last hit: ${this.lastHitText || '—'}`,
      `guards   ${this.guardLine()}`,
      `items    ${this.items.list().length} on the floor   carrying ${this.weapons.inventory.join('+') || 'nothing'}`,
      `frame    ${this.frameTimeMs.toFixed(1)} ms`,
      `net      ${this.netLine()}`,
      `F1 colliders:${this.debug.collidersVisible ? 'ON' : 'off'}  F2 hitboxes:${this.debug.hitboxesVisible ? 'ON' : 'off'}  F3 vision:${this.debug.visionVisible ? 'ON' : 'off'}  F5 role  F6/F7 arm  F8 reset round  F9 unstick`,
      `B spawn bot   N bot role   V bot weapon   M clear bots`,
      `E pick up   G discard   RMB draw/put away   SCROLL switch   LMB shoot/strike   R reload`,
    ]);
  }

  /** Guard headcount by state — the readout the §37 test is actually run against. */
  private guardLine(): string {
    const guards = this.npcSnapshots.filter((n) => n.kind === 'guard');
    const alive = guards.filter((n) => n.alive);
    const counts = new Map<string, number>();
    for (const g of alive) counts.set(g.mode, (counts.get(g.mode) ?? 0) + 1);
    const modes = [...counts].map(([mode, n]) => `${n} ${mode}`).join('  ') || '—';
    const general = this.npcSnapshots.find((n) => n.kind === 'general');
    return `${alive.length}/${guards.length} alive   ${modes}   general ${general?.alive ? 'alive' : 'DOWN'}`;
  }

  private netLine(): string {
    if (!this.net.connected) {
      return this.net.status === 'offline' ? 'offline (solo)' : this.net.status;
    }
    const parts = [
      `online #${this.localId}`,
      `${this.remotes.size} remote`,
      `${this.rttMs.toFixed(0)} ms rtt`,
    ];
    if (!this.alive) {
      const left = Math.max(0, combatCfg.respawnDelay - (performance.now() - this.deadSince) / 1000);
      parts.push(`respawn in ${left.toFixed(1)}s`);
    }
    if (this.lastCorrection) parts.push(`last correction: ${this.lastCorrection}`);
    return parts.join('   ');
  }

  private readonly onResize = () => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rig.resize(window.innerWidth / window.innerHeight);
  };
}
