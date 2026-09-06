/**
 * Every gameplay tuning value lives here (CLAUDE.md §39).
 * If you find a magic number anywhere else in the codebase, it belongs in this file.
 */
export const GAME_CONFIG = {
  movement: {
    // Walk / sprint / jump strength and stamina are PER ROLE — see shared/roles.ts.
    // Everything below applies to every character equally.
    gravity: 18, // m/s^2

    /** Speed the walk animation is normalised against; not a gameplay value. */
    animationReferenceSpeed: 3.8,
    /**
     * How fast the body slews toward the crosshair while a weapon is drawn, in
     * rad/s. Fast enough that a stationary 180° flip reads as a turn, not a pop.
     */
    aimTurnRate: 18, // rad/s
    /**
     * Speed the run clip is normalised against, and the point where the blend
     * finishes crossing from walk to run. Between the two roles' extremes (4.5
     * for the secretary, 7.0 for the officer) so nobody sprints on a walk clip.
     */
    animationRunSpeed: 6.0,

    groundAccel: 55, // m/s^2 — how fast we reach target speed on the ground
    groundDecel: 60, // m/s^2 — how fast we stop when input is released
    airAccel: 12, // m/s^2 — modest air control, not zero
    maxFallSpeed: 40,

    // Small grace window after walking off a ledge where jumping still works.
    coyoteTime: 0.1,
    // Pressing jump slightly before landing still jumps.
    jumpBuffer: 0.12,
  },

  player: {
    height: 1.8, // m, feet to top of head
    radius: 0.35, // m, collision cylinder radius
    eyeHeight: 1.62, // m, used as the camera pivot / shot origin
    stepHeight: 0.35, // m, max ledge we walk up without jumping
    // How far below the feet we look for ground before we consider ourselves
    // airborne. Must exceed stepHeight, or walking DOWN a ledge you just walked
    // UP produces a short free-fall.
    groundSnapDistance: 0.45,
  },

  camera: {
    fov: 75,
    near: 0.05,
    far: 400,
    distance: 4.2, // m behind the pivot
    shoulderOffset: 0.65, // m to the right
    heightOffset: 0.15, // m above eye height
    minDistance: 0.6, // camera pulls in this close when a wall is behind you
    collisionPadding: 0.25,
    sensitivity: 0.0022, // radians per pixel of mouse movement
    minPitch: -1.2, // radians
    maxPitch: 1.0,
    /**
     * Tighter profile used while a weapon is drawn: closer, over the shoulder,
     * narrower FOV. Blended in/out at `blendRate` so nothing pops.
     */
    aim: {
      distance: 1.8, // m behind pivot
      shoulderOffset: 0.35, // m to the right
      heightOffset: 0.22, // m above eye height
      fov: 62, // degrees
      blendRate: 8, // 1/s — how fast the blend eases in and out
    },
  },

  world: {
    wallHeight: 3.2,
    wallThickness: 0.3,
    doorWidth: 2.4,
    /** How close a player must be to work a door with [E]. */
    doorReach: 2.0,
    /** How long a leaf takes to swing through its 90 degrees. Cosmetic only. */
    doorSwingSeconds: 0.35,
    /**
     * Guards push open any shut door they come this close to. They have keys,
     * and it is what keeps doors out of the nav grid entirely — see doors.ts.
     */
    guardDoorOpenRadius: 1.3,
    /** How close a player must be to search a container with [E]. */
    containerReach: 2.0,
    /** How long the hold interaction takes. */
    containerSearchSeconds: 3,
  },

  combat: {
    // Bullet damage is flat per weapon and hit class — see WEAPONS in
    // shared/weapons.ts. The differentiator is the target's health, not the gun.

    /** Per-role strike damage is in shared/roles.ts; this is the swing itself. */
    melee: {
      range: 2.0, // m, measured horizontally between the two bodies
      halfAngle: Math.PI * 0.35, // must be roughly facing them
      cooldown: 0.7, // s between swings
      /**
       * Seconds the attacker cannot move after clicking. Roots the body so the
       * swing does not slide through the target, and stops the character spinning
       * mid-punch because travel direction changed.
       */
      attackLock: 0.45, // s
      /**
       * How long a hit victim cannot move or shoot. Short enough to survive, long
       * enough to feel. Both the local player (when struck by a server melee hit)
       * and NPCs use this value.
       */
      stunDuration: 0.6, // s
    },

    /**
     * How far a client's claimed shot origin may sit from where the server
     * believes that player is. Generous enough for jitter, far too small to
     * shoot around a corner.
     */
    maxShotOriginError: 2.0, // m
    /** Grace on the weapon's own fire interval, absorbing network jitter. */
    fireRateSlack: 0.85,
    /** Seconds a corpse lies there before the player may respawn. */
    respawnDelay: 4,
  },

  /** Weapons lying on the floor (CLAUDE.md §7, §23). */
  items: {
    /** How close you must stand to pick something up. */
    reach: 2.0, // m
    /** How far in front of you a dropped weapon lands. */
    dropDistance: 0.9, // m
    /** Radius the dead scatter their kit over. */
    deathScatter: 0.7, // m
  },

  guards: {
    reactionDelay: 0.75, // s of seeing the offence before reacting at all
    /**
     * Seeing someone past a posted shoot-on-sight line — inside the General's
     * office, or armed in front of him. There is nothing to discuss, so this
     * replaces BOTH the reaction delay and the beat before the first shot: the
     * rule is posted, and a guard who waits it out there is not doing his job.
     */
    shootOnSightReaction: 0.25, // s
    warningDuration: 2.0, // s of grace to put the weapon away
    accuracy: 0.7, // 1.0 would be an aimbot; this is beatable
    viewDistance: 22, // m
    viewAngle: Math.PI * 0.45, // half-angle of the vision cone
    patrolSpeed: 2.0, // m/s
    approachSpeed: 3.2, // m/s while closing on a suspect
    /** Guards stop closing at this range and challenge from there. */
    standoff: 5.0, // m
    /** Seconds between a hostile guard's shots. */
    fireInterval: 1.1,
    /** Losing sight of a suspect for this long ends the alert. */
    loseSightAfter: 4.0, // s
    /** How far a shouted warning carries to human players. */
    shoutRadius: 20, // m
    waypointReach: 0.9, // m — patrol tolerance; a route is walked tighter
    /**
     * How close counts as having reached a waypoint on a computed route.
     * Much tighter than `waypointReach`: at the patrol tolerance a guard cut
     * the corner off a doorway, dropped the waypoint that was IN the doorway,
     * and then set off straight at the next one — through the wall beside it.
     */
    pathWaypointReach: 0.35, // m
    /**
     * How far the noise of shooting a guard travels, in metres. Every guard
     * inside the radius turns on the shooter — you do not get to pick them off
     * one at a time in a corridor. A kill carries further than a wound.
     *
     * 60 m is the whole compound, i.e. "everyone". Turn it down if playtests say
     * murdering one sentry should be survivable.
     */
    provokeRadiusOnKill: 60, // m
    provokeRadiusOnHit: 25, // m
    /** All guards within this radius respond to a door access violation. */
    doorViolationRadius: 25, // m

    /**
     * Hearing (CLAUDE.md §17 — guards enforce obvious rules, and a gunshot is
     * the most obvious event in the compound). A noise does not tell a guard
     * WHO made it: he walks over to look, and what he finds when he gets there
     * is up to whoever is still standing.
     */
    gunshotHearRadius: 45, // m — most of the compound hears a rifle
    /**
     * A LANDED strike only, and barely audible. Melee is the ineffective but
     * SAFE option and that trade is the whole reason to pick it: a missed swing
     * makes no noise at all, and a landed one is heard only by whoever is
     * already in the room. See CombatSystem.melee and Game.strike.
     */
    meleeHearRadius: 3, // m
    /**
     * Seconds a guard will spend on one noise before returning to his route.
     * A floor, not the whole budget: the real deadline is this or the time the
     * route he is actually walking takes plus `investigateSlack`, whichever is
     * longer, so a shot at the far end of the compound is still worth the walk.
     */
    investigateTimeout: 11,
    /** Grace on top of the computed walking time before he gives up. */
    investigateSlack: 4, // s
    /** How often a moving NPC recomputes its route. */
    repathInterval: 0.5, // s
    /** How far the goal must move before the route is thrown away early. */
    repathGoalDrift: 1.5, // m
    /** How close to the noise counts as having arrived. */
    investigateReach: 1.5, // m
    /** Seconds spent standing at the spot looking round before giving up. */
    investigateLinger: 4,
    /** How fast he sweeps his head while looking around, in rad/s. */
    investigateSweepRate: 1.1,
    /**
     * Half-width of that sweep, in radians, measured either side of the
     * direction he walked in on. He used to spin on the spot from whatever yaw
     * he happened to have, which meant a guard standing on a gunshot spent most
     * of his time facing away from wherever it had come from.
     */
    investigateSweepArc: 1.2, // rad, ~70 degrees
    /**
     * How far apart responders space their destinations. Every guard who hears
     * a shot paths to the exact same square metre otherwise, and they arrive to
     * find each other in the doorway.
     */
    investigateSpread: 1.2, // m
    /**
     * Seconds a posted sentry keeps facing a noise before returning to his post
     * yaw. He never leaves his post — turning is the whole response.
     */
    alertLookDuration: 4, // s
    /**
     * Stuck detection. An NPC who is trying to move and is not moving is
     * grinding against something: at `stuckRepathAfter` the route is thrown
     * away and rebuilt from where he actually is, and at `stuckGiveUpAfter`
     * the goal itself is written off. Without this a guard who ended an
     * investigation inside a one-door room pressed himself into the wall
     * nearest his next waypoint and stayed there for the rest of the round.
     */
    stuckRepathAfter: 0.6, // s
    stuckGiveUpAfter: 2.5, // s
    /**
     * A calm guard will walk over to a dropped weapon if it is within this
     * distance AND in his view cone (plan §6). Outside this or behind a wall,
     * he ignores it — the weapon is not visible to him.
     */
    itemSightRadius: 8, // m
    /** Seconds he will keep pursuing a dropped item before giving up. */
    itemRetrieveDeadline: 12, // s
  },

  /**
   * The General (CLAUDE.md §25, §26). He is not a boss fight — he never shoots.
   * Everything here exists to make him a target that has to be *reached*,
   * rather than one that stands still and absorbs fire.
   */
  general: {
    /** m/s while running for cover. Slower than a sprinting player, on purpose. */
    fleeSpeed: 3.6,
    /** How often he re-picks a hiding place as the threat moves. */
    coverRefresh: 0.7, // s
    /** How far off a prop he stands when using it as cover. */
    coverStandoff: 0.4, // m
    /** A prop shorter than this is furniture to duck behind, not cover to hide behind. */
    coverMinHeight: 1.6, // m
    /** Hits taken before he stops hiding and runs for the door. */
    hitsBeforeBolting: 2,
    /** Seconds without a sign of the threat before he goes back to his desk. */
    calmAfter: 8, // s
    /**
     * A gunshot this close is about him whether or not he saw who fired it.
     * Reaches down the north corridor and into the HQ approach, and no further:
     * a shot in Storage is not his business.
     */
    alarmRadius: 14, // m
  },

  /**
   * The round (CLAUDE.md §25, §43 — "basic win conditions work").
   *
   * A round is what makes the win conditions mean anything: without a boundary
   * there is nothing to win, and without hidden factions there is nobody to win
   * it. Everything else in this prototype can be tested in a sandbox; this
   * cannot.
   */
  /**
   * The Security Officer's patrol (CLAUDE.md §15, §32).
   *
   * The interval is the whole mechanic: long enough that patrolling is not a
   * treadmill, short enough that an officer who never leaves the General's door
   * is visibly neglecting his job — which is information the other players get
   * to act on. Two to three minutes, per the design.
   */
  duty: {
    /** Base seconds between checkpoints. */
    patrolIntervalSeconds: 150,
    /** Randomised +/- this, so the officer cannot set a metronome by it. */
    patrolJitterSeconds: 30,
    /** Seconds he must stand inside the checkpoint box for it to count. */
    patrolDwellSeconds: 3,
    /** Seconds the secretary has to complete one leg of a delivery. */
    deliverySeconds: 120,
    /**
     * Missed deliveries before HQ access is revoked for the rest of the round.
     * Two, not one: the first miss has to be survivable or the duty is a trap
     * rather than a pressure, and the second is a decision the player watched
     * themselves make.
     */
    deliveryMissesBeforeBan: 2,
    /** Seconds of holding E to collect or hand over a dispatch. */
    deliveryHoldSeconds: 2,
    /** How close the secretary must be to the desk to hand a dispatch over. */
    deliveryReach: 3,
  },
  round: {
    /** How long a round runs before the loyalists win by having survived it. */
    durationSeconds: 900, // 15 minutes
    /** Players needed before a round can start at all. */
    minPlayers: 2,
    /**
     * Ward patients who have to die before the compound is judged to have lost
     * the medical ward. Both of them — losing one is a bad day for the doctor,
     * losing both is the ward gone.
     */
    patientsLostToLose: 2,
    /** Seconds the result banner stays up before the next round can start. */
    intermissionSeconds: 20,
    /**
     * Death is final while a round is running.
     *
     * This is forced by the loyalist win condition: "every infiltrator is dead"
     * can never be true if the dead come back in four seconds. It is also a real
     * change to how the game feels — a firefight now ends someone's round — so
     * it is a switch. Turn it off to playtest movement and combat, turn it on to
     * playtest the game. Respawn works normally in the lobby and after the round
     * is over either way.
     */
    permanentDeath: true,
  },

  /** Blood-spurt particle burst when a corpse is shot (Effects.ts). */
  bloodSpurt: {
    poolSize: 32,
    particlesPerBurst: 8,
    speed: 4.5, // m/s initial velocity
    spread: 0.6, // cone half-angle in radians
    gravity: 9.0, // m/s^2 pulling particles down
    lifetime: 0.35, // s
  },

  // Not implemented yet (milestone 5), but the tuning value lives here from the
  // start so balance stays in one place.
  chat: {
    proximityRadius: 12, // m
    broadcastCooldownSeconds: 45,
  },

  minimap: {
    rangeMeters: 30,
  },

  search: {
    reach: 2,
    immunitySeconds: 60,
    decisionSeconds: 15,
  },

  telegram: {
    npcIntervalSeconds: 60,
    deciphersForIntel: 3,
  },

  medical: {
    woundedSeconds: 150,
    criticalSeconds: 75,
    examineSeconds: 1.5,
    treatSeconds: 2.5,
    /**
     * How long a treated patient stays stable before deteriorating again. The
     * ward is a loop, not a checklist: the doctor is never finished, so being
     * somewhere else for two minutes always costs something.
     */
    stableSeconds: 60,
    /** Patients start wounded on staggered clocks, +/- this many seconds. */
    startJitterSeconds: 45,
  },
} as const;
