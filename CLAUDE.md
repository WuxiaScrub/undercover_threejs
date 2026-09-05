# CLAUDE.md

# Three.js Multiplayer Espionage Game — Gameplay Prototype

## 1. Purpose

This project is a **disposable Three.js gameplay prototype** for testing whether the core multiplayer social-deduction / espionage gameplay loop is fun.

This is NOT the production version of the game. MVP networking must support LAN multiplayer so the developer can run the server on one PC and have 4–6 people connect from other computers on the same local network.

Use a simple Node.js WebSocket server initially.

The server should bind to the local network interface (e.g. 0.0.0.0) rather than only localhost.

Players connect using the host computer's local IP address, e.g.:

ws://192.168.1.100:3000

The prototype does not need Internet/WAN multiplayer, matchmaking, accounts, Steam networking, or port forwarding.

The networking layer should be kept reasonably isolated so WAN/Steam networking can be added later without rewriting gameplay systems.

Prioritize:

1. Movement feel
2. Shooting and hit detection
3. Physics / collision
4. Guard NPC reactions
5. A compact military compound map
6. Hidden-faction gameplay
7. Basic proximity text chat
8. Fast iteration and playtesting

Do NOT spend significant time on:
- polished art
- sophisticated animations
- advanced UI
- elaborate inventory systems
- realistic AI
- sophisticated networking infrastructure
- audio polish
- production architecture
- optimization for large player counts
- Steam integration

The prototype should answer:

> "Is this game loop fun when several humans are moving around the compound, performing legitimate duties, hiding their allegiance, acquiring weapons, shooting, searching, and trying to protect or assassinate the General?"

---

# 2. Core Game Concept

The game is a multiplayer hidden-faction espionage / assassination game set in a fictional East Asian military compound around 1942.

There are two hidden factions:

### Loyalists

Goal:
- Protect the General.
- Identify enemy infiltrators.
- Prevent the assassination.

### Infiltrators

Goal:
- Assassinate the General.
- Avoid being identified before completing the assassination.

Every player has:

1. A PUBLIC occupation.
2. A HIDDEN allegiance.

The public occupation is visible to everyone.

The hidden allegiance is visible only to the player.

Example:

- Secretary + Loyalist
- Secretary + Infiltrator

Both appear to everyone as "Secretary."

The important design principle is:

> Public occupation determines what a character is legitimately allowed to do. Hidden allegiance determines how they use those capabilities.

A player should frequently be able to explain suspicious behavior with an innocent explanation.

---

# 3. Prototype Scope

Initial prototype:

- 4–6 human players
- One General NPC
- Several Guard NPCs
- One compact military compound
- Four public occupations
- Two hidden factions
- Third-person camera
- Walk
- Sprint
- Jump
- Collision
- Gravity
- Shooting
- Health
- Weapon damage
- Weapon pickup
- Weapon concealment / brandishing
- Guard suspicion
- Guard shooting
- Basic duties
- Proximity text chat
- Basic accusation / elimination if time permits
- Basic win conditions

Do not implement a giant game.

The entire map should be small enough that players can encounter one another frequently.

---

# 4. Technology

Use:

- Three.js
- JavaScript or TypeScript
- Vite
- WebSocket-based multiplayer if multiplayer is implemented
- Simple custom server using Node.js

Prefer TypeScript if project setup does not substantially slow development.

Use Three.js for:

- rendering
- cameras
- raycasting
- scene management
- animation
- basic geometry

Use a lightweight physics/collision solution if necessary.

Do NOT build a custom physics engine.

For the prototype, simple capsule-vs-static-environment collision is sufficient.

---

# 5. Architecture Philosophy

Keep the project simple.

Suggested structure:

```text
src/
  client/
    main.ts
    game/
      Game.ts
      GameState.ts
      Input.ts
      Camera.ts
    player/
      Player.ts
      PlayerController.ts
      PlayerRenderer.ts
    weapons/
      Weapon.ts
      WeaponSystem.ts
    npc/
      Guard.ts
      GuardAI.ts
      General.ts
    map/
      Compound.ts
      Collision.ts
    chat/
      ProximityChat.ts
    ui/
      HUD.ts
      ChatUI.ts

  server/
    server.ts
    GameServer.ts
    PlayerState.ts
    CombatSystem.ts
    GuardSystem.ts

  shared/
    types.ts
    constants.ts
    roles.ts
    weapons.ts

Do not create every file immediately.

Create only what is needed.

6. Multiplayer Authority

The server should ultimately be authoritative for:

player positions
player health
weapons
shooting
hit detection
faction
role
guard state
General state
win conditions

The client may predict movement for responsiveness, but the server is the source of truth.

Do not trust client-reported:

damage
kills
faction
weapon ownership
hit results

For an extremely early single-player gameplay prototype, temporarily allow client-side logic if it dramatically accelerates development.

However, structure the code so combat can later move to the server.

7. Camera

Use third-person as the default.

Camera:

behind player
slightly above shoulder level
mouse-controlled rotation
character follows camera orientation
WASD movement relative to camera

Basic camera controls:

Mouse movement = rotate camera
W = forward
S = backward
A/D = strafe
Space = jump
Shift = sprint

The camera should feel like a conventional third-person PC action game.

Do not spend time implementing a first-person mode in the MVP.

Keep the architecture sufficiently clean that first-person could be added later.

8. Movement

Movement is one of the highest-priority systems.

It must feel responsive.

Implement:

Walking

Normal movement speed.

Suggested starting value:

walk speed = 3.5–4.0 m/s
Sprinting

Hold Shift.

Suggested:

sprint speed = 5.5–6.5 m/s

Sprinting should be noticeably faster.

Jumping

Space.

Suggested:

jump velocity = approximately 5–6 m/s

Use gravity.

The player should:

accelerate naturally enough to feel good
stop reasonably quickly when input is released
not slide excessively
not float
not double jump
Air control

Allow modest air control.

Do not make the character completely uncontrollable in the air.

Character rotation

The character should generally face the direction of movement.

When aiming/shooting, character orientation should follow the aim direction.

9. Collision and Physics

Collision is critical.

Players must not:

walk through walls
walk through furniture
walk through doors
fall through floors
walk through other solid obstacles

The compound should use simple collision geometry.

Do NOT create complicated per-triangle physics unless necessary.

Prefer:

boxes
capsules
simple convex shapes
invisible collision volumes

Visual geometry and collision geometry may be separate.

Example:

Wall:
    visible mesh
    box collision

Desk:
    visible mesh
    box collision

Door:
    visible mesh
    box collision

The player can be represented by a capsule for collision.

Approximate player dimensions:

height: 1.7–1.9m
radius: 0.3–0.4m

Implement:

gravity
ground detection
wall collision
obstacle collision
step handling if reasonably easy

Do not implement ragdoll physics.

10. Player Health

Each character/role has a different maximum health value.

Make health data-driven.

Example starting values:

Security Officer: 120 HP
Doctor:            100 HP
Secretary:          90 HP
Telegram Operator: 95 HP

These are tuning values, NOT final game balance.

Keep them easy to change.

Example:

ROLE_STATS = {
  security: {
    maxHealth: 120
  },

  doctor: {
    maxHealth: 100
  },

  secretary: {
    maxHealth: 90
  },

  telegramOperator: {
    maxHealth: 95
  }
}

Health should be displayed in the HUD for the local player.

Do not necessarily display exact enemy health.

11. Weapons

There are two weapon types in the prototype:

Rifle

Primarily available to Security Officer.

Characteristics:

long range
high damage
relatively accurate
conspicuous
slower movement while equipped

A rifle shot hitting:

head = instant kill
torso = instant kill
limb = requires 2 hits

Therefore, rifle damage should be sufficient to kill every role with one head or torso shot.

Do not implement armor in the MVP.

Pistol

Can be carried by:

Security Officer initially
any role that discovers a hidden pistol

Characteristics:

shorter effective range
less accurate
easier to conceal
weaker than rifle

Damage rules:

Head

1 shot kills.

Torso

2 shots required.

Limbs

2 shots required.

The exact HP values should be balanced around these rules.

Important:

Hit location matters.

The prototype must distinguish:

head
torso
left arm
right arm
left leg
right leg
12. Shooting

Shooting should feel immediate and reliable.

Use hitscan for the MVP.

Do NOT implement physical bullets.

When firing:

Determine weapon.
Determine firing origin.
Determine aim direction.
Raycast.
Determine hit object.
Determine hit location.
Apply appropriate damage.
Play simple muzzle flash.
Play simple hit effect.
Update health.

Use Three.js Raycaster for the initial implementation.

Later, server-side raycasting can replace client-side hit detection.

13. Hitboxes

Use simple hitboxes.

Each character should have separate collision/hit regions:

HEAD
TORSO
LEFT_ARM
RIGHT_ARM
LEFT_LEG
RIGHT_LEG

These can be invisible primitive meshes.

Example:

          [HEAD]
             |
          [TORSO]
        /    |    \
   [L ARM]   |   [R ARM]
             |
        [PELVIS]
         /    \
   [L LEG]   [R LEG]

The visual character does not need to be anatomically perfect.

The important thing is reliable hit detection.

Make hitbox debugging easy.

Add a developer/debug mode that can display hitboxes.

14. Weapon State

A player weapon should have at least these states:

UNARMED
HOLSTERED
BRANDED
FIRING

The important gameplay distinction is:

Concealed

Weapon is not visibly held.

Brandished

Weapon is visibly held.

NPC guards can react to brandished weapons.

The prototype does NOT need sophisticated concealment animations.

It is sufficient for the system to track:

weaponVisible: boolean

and render the weapon in the player's hand when visible.

15. Security Officer

Public occupation:

Security Officer.

Starting equipment:

pistol
rifle

The player can switch between weapons.

Security Officer is the strongest armed role but also has legitimate responsibilities.

Security Patrol

Security Officer should have patrol checkpoints.

Example:

Checkpoint A
     ↓
Checkpoint B
     ↓
Checkpoint C
     ↓
Checkpoint A

The officer is expected to periodically visit checkpoints.

Missing patrol requirements should temporarily disable their search ability.

Do NOT permanently remove the ability.

Once the officer resumes patrol and reaches the required checkpoint, the ability returns.

This exists to prevent:

Security Officer camps beside the General for the entire match.

The officer needs a legitimate reason to leave the General's area.

16. Searching Players

Security Officer can search another player.

Requirements:

close physical proximity
explicit interaction
takes time
both players are occupied during the search

The search should NOT be instantaneous.

Suggested duration:

2–4 seconds

During the search:

both players have reduced movement or are stationary
Security Officer cannot immediately shoot
search can reveal concealed weapons

If a hidden pistol is discovered:

"Concealed weapon found."

The Security Officer should know.

The rest of the players should NOT automatically know.

This creates information asymmetry.

Example:

Secretary secretly possesses pistol.

Security Officer searches Secretary.

If the Security Officer discovers the pistol but intentionally claims not to have found anything, the Secretary can infer:

"The Security Officer is probably my teammate."

This kind of human inference is a core gameplay mechanic.

17. Guard NPCs

Guards are deliberately simple.

They are NOT detectives.

They should enforce obvious security rules.

Their core question is:

"Is this behavior obviously suspicious or dangerous?"

NOT:

"Can I solve who the infiltrators are?"

18. Guard Suspicion

Guards should react to obvious suspicious behavior.

Examples:

Brandishing a weapon

If:

Doctor has pistol visibly in hand
Secretary has pistol visibly in hand
Telegram Operator has pistol visibly in hand

a nearby guard should become suspicious.

Security Officer may legitimately brandish a weapon.

The guard should therefore use role-specific rules.

Example:

Security Officer + visible rifle
    = normal

Security Officer + visible pistol
    = normal

Doctor + visible pistol
    = suspicious

Secretary + visible pistol
    = suspicious

Telegram Operator + visible pistol
    = suspicious
19. Guard Response

Start with a simple state machine.

PATROL
  ↓
SUSPICIOUS
  ↓
WARNING
  ↓
HOSTILE

Example:

PATROL

Guard walks a predefined route.

SUSPICIOUS

Guard sees a non-authorized player brandishing a weapon.

Guard:

turns toward player
approaches
raises weapon
optionally gives a warning

Example warning:

"Put the weapon away!"

WARNING

Give player a short opportunity to comply.

If weapon is concealed:

return to PATROL

If player continues brandishing:

HOSTILE
HOSTILE

Guard shoots the player.

The guard does not need sophisticated tactics.

20. Guard Shooting

Guards should use simple hitscan shooting.

Do not build advanced combat AI.

They should:

acquire suspicious target
aim toward target
shoot
apply damage
stop shooting when target is dead/downed or no longer considered hostile

Use modest accuracy.

The guard should NOT be an unbeatable aimbot.

Give them:

reaction delay
limited accuracy
reasonable firing interval

This allows players to potentially escape.

21. Guard Line of Sight

Guards should only react when they can reasonably see the suspicious behavior.

Use a simple raycast from guard to player.

If a wall blocks line of sight:

guard does not see weapon

This is important.

It allows players to:

duck behind walls
hide weapons
use rooms
exploit sight lines

This makes the physical map matter.

22. Guard Role Authorization

Create a simple authorization system.

Example:

canBrandishWeapon(role, weapon)

Possible rules:

Security Officer:
    pistol = allowed
    rifle = allowed

Doctor:
    pistol = not allowed
    rifle = not allowed

Secretary:
    pistol = not allowed
    rifle = not allowed

Telegram Operator:
    pistol = not allowed
    rifle = not allowed

Do NOT hard-code these rules throughout the AI.

Keep them centralized.

23. Hidden Pistols

Rare hidden pistols should exist in the environment.

Example locations:

locked drawer
desk drawer
storage cabinet
office drawer

Only a few should exist.

The exact spawn location can be randomized.

Players can:

Find pistol.
Pick it up.
Conceal it.
Move elsewhere.
Reveal it.
Shoot.
Drop it.

Do not implement a large inventory.

One weapon slot is enough for the prototype.

24. Roles

Initial public roles:

Security Officer
armed
patrols
can search
legitimate weapon use
higher health
Secretary
access to General's office
access to important documents
access to telegram room
starts unarmed
can discover concealed pistol
Doctor
access to medical ward
access to medical supplies
starts unarmed
can discover concealed pistol
Telegram Operator
operates telegram room
receives intelligence
starts unarmed
can discover concealed pistol

All roles can potentially belong to either faction.

25. General

There is exactly ONE General.

For the prototype:

stationary
located in General's office
surrounded by guards
cannot be controlled by players

The General should be visually obvious.

The Infiltrator win condition can be as simple as:

Kill General

The Loyalist win condition:

Prevent General's death
AND eliminate all infiltrators

Keep the win rules simple initially.

26. Assassination

The General should have a hitbox.

Players can shoot the General.

However:

guards should protect the General
restricted access should matter
the General should not be trivially exposed to the entire map

The goal is to create:

opportunity → risk → suspicion → action

rather than:

walk into office → click General → instantly win
27. Military Compound

Build one compact compound.

Do not create a huge open-world map.

Suggested layout:

                 NORTH

        ┌─────────────────────┐
        │     GENERAL HQ      │
        │                     │
        │   General Office    │
        │       + Guards      │
        └──────────┬──────────┘
                   │
             Main Corridor
                   │
     ┌─────────────┼─────────────┐
     │             │             │
     │  Admin      │   Waiting   │
     │  Office     │   Area      │
     │             │             │
     ├─────────────┼─────────────┤
     │             │             │
     │  Telegram   │   Medical   │
     │  Room       │   Ward      │
     │             │             │
     ├─────────────┴─────────────┤
     │                           │
     │       Central Hall        │
     │                           │
     ├─────────────┬─────────────┤
     │             │             │
     │  Security   │   Storage   │
     │  Office     │             │
     │             │             │
     └─────────────┴─────────────┘

                  SOUTH

This is only a conceptual layout.

Feel free to adjust the exact layout if gameplay is better.

28. Map Design Principles

Every important room should have a gameplay reason to exist.

General Office
General
guards
assassination target
Secretary access
Telegram Room
intelligence
Telegram Operator duties
player traffic
Medical Ward
Doctor duties
information
legitimate player traffic
Security Office
Security Officer
patrol information
weapon-related activity
Storage
possible hidden pistol
less supervised area
ambush / secret meeting opportunities
Central Hall / Corridors
player encounters
observation
pursuit
guards

Avoid empty rooms.

29. Visual Style

Use placeholder geometry.

Examples:

walls = boxes
floor = planes
tables = boxes
doors = simple rectangular meshes
players = capsules / simple humanoid shapes
guards = simple humanoid shapes
General = distinct colored/marked capsule
weapons = primitive meshes

Do NOT spend time finding perfect 1942 assets.

The visual prototype only needs to communicate:

"This is a military compound."

A basic stylized environment is acceptable.

30. Player Identification

Players need to be visually distinguishable.

For MVP:

simple character models
role label above head

Example:

SECRETARY

The role label is public.

Do NOT display faction.

Never display:

LOYALIST
INFILTRATOR

unless in developer/debug mode.

31. Proximity Text Chat

Text-only chat.

No voice chat.

When a player sends a message:

only nearby players receive it
distant players do not see it

Suggested chat radius:

10–15 meters

The server should enforce the filtering.

Do not create secret faction chat.

Hidden teammates must physically meet to communicate.

This is intentional.

32. Basic Duties

Do not build complex minigames.

Duties should mainly create reasons to move around the compound.

Examples:

Security Officer

Visit patrol checkpoints.

Secretary

Deliver/receive a report.

Doctor

Visit medical ward / handle medical supplies.

Telegram Operator

Process telegrams.

These activities should take only a few seconds.

The important result is:

Players have legitimate reasons to be in different places.

33. Telegram Intelligence

The Telegram Operator can receive simple intelligence messages.

Examples:

"Enemy intelligence reports an infiltrator may have access to the medical ward."

"An unknown female operative was observed near the western corridor."

"An infiltrator may have been seen entering the storage area."

"Enemy activity has been reported near headquarters."

Do not make clues perfectly identify a player.

The purpose is to generate uncertainty and conversation.

For the first prototype, even a handful of predefined clues is acceptable.

34. Suspicion Philosophy

Do NOT make the game depend on explicit suspicion scores.

Suspicion should emerge from observable behavior.

Examples:

Doctor repeatedly entering Security Office
Secretary leaving storage room
Telegram Operator meeting another player privately
non-security role brandishing a pistol
Security Officer abandoning patrol
player repeatedly following another player
someone spending unusual amounts of time near General

The system should provide observable events.

Humans should interpret them.

35. Do NOT Build

The following are explicitly out of scope for the MVP:

LLM-powered NPC detectives
advanced NPC reasoning
cameras
GPS
smartphones
modern surveillance systems
complex inventory
crafting
armor
vehicles
large weapon arsenal
advanced ballistics
ragdolls
realistic destruction
elaborate animations
procedural map generation
matchmaking
accounts
Steam integration
voice chat
cosmetics
progression
monetization
dedicated production servers
36. Development Order

Implement in this order.

Phase 1 — Basic 3D scene

Create:

Three.js scene
lighting
camera
basic compound
floor
walls
doors
obstacles

Goal:

Can I walk around the compound?

Phase 2 — Player controller

Implement:

WASD
mouse camera
walk
sprint
jump
gravity
collision

This is extremely important.

Do not move on until movement feels reasonably good.

Phase 3 — Multiplayer movement

Implement:

player connection
spawning
remote players
synchronized position
synchronized rotation

Goal:

Four people can run around the compound together.

Phase 4 — Weapons

Implement:

pistol
rifle
equip
holster
visible weapon
shooting
muzzle flash
sound placeholder
raycast
Phase 5 — Hit detection

Implement:

head hitbox
torso hitbox
limb hitboxes
damage
death

Test extensively.

The shooting model should be predictable.

Phase 6 — Health balancing

Implement role health.

Make values configurable.

Verify:

Rifle

Head → 1 shot
Torso → 1 shot
Limb → 2 shots

Pistol

Head → 1 shot
Torso → 2 shots
Limb → 2 shots

Test against every role.

Phase 7 — Hidden weapons

Implement:

weapon pickup
conceal weapon
brandish weapon
drop weapon
hidden pistol spawn points
Phase 8 — Guards

Implement:

patrol
line of sight
weapon detection
warning
shooting
simple accuracy
reaction delay

First test:

Doctor walks around normally → guards ignore.

Then:

Doctor pulls out pistol in front of guard → guard reacts.

Then:

Doctor hides pistol behind wall → guard cannot react.

This test is mandatory.

Phase 9 — Roles

Implement:

Security Officer
Secretary
Doctor
Telegram Operator

Public role labels.

Hidden faction assignment.

Do not reveal faction.

Phase 10 — General

Implement:

General NPC
General office
guards
General health
assassination
Phase 11 — Duties

Implement minimal duties.

Do not build minigames.

Phase 12 — Proximity chat

Implement:

chat box
message sending
distance filtering
server-side filtering
Phase 13 — Full gameplay loop

Implement:

Lobby
 ↓
Role assignment
 ↓
Hidden faction assignment
 ↓
Spawn
 ↓
Perform duties
 ↓
Gather information
 ↓
Find / conceal weapons
 ↓
Meet other players
 ↓
Investigate
 ↓
Assassination attempt
 ↓
Combat / accusation
 ↓
Win condition
37. Testing Priorities

After every major system, manually test.

Movement tests
walk
sprint
jump
stairs/steps if present
walls
corners
furniture
doors
compound boundaries
Combat tests
rifle head
rifle torso
rifle limb
pistol head
pistol torso
pistol limb
every player role
General
guard
Guard tests
Doctor walking normally.
Doctor holding no weapon.
Doctor holding concealed pistol.
Doctor brandishing pistol.
Doctor brandishing pistol behind wall.
Doctor brandishing pistol in guard's line of sight.
Security Officer holding rifle.
Security Officer holding pistol.

Expected:

Authorized weapon behavior → ignored
Unauthorized visible weapon → suspicious
No line of sight → ignored
Continued suspicious behavior → guard attacks
38. Debug Tools

Create simple developer controls.

Examples:

F1 = show collision volumes
F2 = show hitboxes
F3 = show NPC vision rays
F4 = show player faction
F5 = show role
F6 = spawn pistol
F7 = give rifle
F8 = reset health
F9 = teleport to General

These should only exist in development mode.

They are extremely useful for debugging.

39. Configuration

Put gameplay tuning values in one place.

Example:

const GAME_CONFIG = {
  movement: {
    walkSpeed: 3.8,
    sprintSpeed: 6.0,
    jumpVelocity: 5.5,
    gravity: 18
  },

  combat: {
    pistol: {
      headDamage: 999,
      torsoDamage: 50,
      limbDamage: 50
    },

    rifle: {
      headDamage: 999,
      torsoDamage: 999,
      limbDamage: 60
    }
  },

  chat: {
    proximityRadius: 12
  },

  guards: {
    reactionDelay: 0.75,
    warningDuration: 2.0,
    accuracy: 0.7
  }
}

Do not scatter magic numbers throughout the code.

40. Important Combat Implementation Detail

Do not blindly use generic damage numbers.

The intended gameplay rule is more important than the raw damage number.

For every hit:

weapon
+
hit location
+
target role
=
damage

For the prototype, it is acceptable to calculate damage using explicit rules.

Example:

if (weapon === RIFLE) {
    if (hitLocation === HEAD) kill();
    else if (hitLocation === TORSO) kill();
    else if (hitLocation === LIMB) damageEnoughForTwoHits();
}

if (weapon === PISTOL) {
    if (hitLocation === HEAD) kill();
    else if (hitLocation === TORSO) damageEnoughForTwoHits();
    else if (hitLocation === LIMB) damageEnoughForTwoHits();
}

Then account for role health appropriately.

The final balance can be tuned later.

41. Performance

The prototype only needs to support approximately:

4–6 human players
+
NPC guards
+
one General

Do not optimize for 100 players.

Do not build an ECS architecture unless Three.js performance actually requires it.

Simple, readable code is preferable.

42. Design Principle

Always ask:

"Does this feature help determine whether the core game loop is fun?"

If not, defer it.

The prototype is successful if players naturally start doing things like:

"Why was the Doctor in the storage room?"
"I saw the Secretary near the General."
"The Security Officer skipped his patrol."
"I think the Telegram Operator knows something."
"I found a pistol."
"Don't shoot, I'm the Doctor!"
"Why did the guard start shooting her?"
"Meet me in the medical ward."
"I think he's lying."
"Someone is trying to get into the General's office."

That human interaction is the actual game.

43. Definition of Done

The Three.js prototype is complete enough for playtesting when:

 4+ players can connect
 players can walk
 players can sprint
 players can jump
 collision works
 players cannot walk through walls
 players can shoot
 head/torso/limb hits are distinguished
 rifle has one-shot head/torso kills
 pistol has one-shot head kills
 pistol requires two torso hits
 limbs require two hits
 role health differs
 pistols can be discovered
 pistols can be concealed
 pistols can be brandished
 guards see visible unauthorized weapons
 guards warn suspicious players
 guards shoot if the warning is ignored
 guards cannot see through walls
 General exists
 General can be assassinated
 four public roles exist
 hidden factions exist
 factions are not publicly displayed
 Security Officer has patrol duties
 proximity chat works
 basic win conditions work

At this point:

STOP.

Do not immediately add more features.

Play the game with 4–6 people.

Observe what actually happens.

44. Claude Code Instructions

When working on this project:

Build the smallest functional implementation first.
Run the project after meaningful changes.
Fix runtime errors before adding new systems.
Do not invent unnecessary architecture.
Do not add dependencies unless they solve a real problem.
Prefer simple primitives over elaborate assets.
Keep gameplay constants configurable.
Keep client rendering separate from gameplay state.
Keep multiplayer transport separate from gameplay logic.
Keep role/faction information server-authoritative.
Never expose hidden faction information to normal clients.
Never assume a system works merely because the code compiles.
Test the actual gameplay behavior.
If a feature is ambiguous, choose the simplest implementation that allows playtesting.
Do not spend time polishing systems that are not needed to answer whether the game is fun.

The goal is not:

"Build a complete game."

The goal is:

"Build enough of the game that 4–6 humans can play it and tell whether the underlying social-deduction/espionage loop is compelling."

45. Final Priority Order

If development time or complexity becomes a problem, prioritize exactly in this order:

Movement feel
Collision
Shooting
Hit detection
Health / damage balance
Guards
Compound layout
Multiplayer
Hidden factions
Weapons / concealment
Roles
General
Proximity chat
Duties
Accusation system
Visual polish
Everything else

A fun ugly prototype is vastly more valuable than a beautiful prototype that does not prove the gameplay loop.