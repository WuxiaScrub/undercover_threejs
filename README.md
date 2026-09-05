# Compound — gameplay prototype

Disposable Three.js prototype for the hidden-faction espionage game. See `CLAUDE.md`
for the design brief. **Milestone 5 (doors, the round, hidden factions, win conditions and the
Security Officer's patrol) is in**, on top of milestone 4's guards, General, floor weapons and
sound.

## Run it

```bash
npm install
npm run play           # game server + client together — this is the one you want
```

`npm run play` starts the WebSocket server on `0.0.0.0:3000` and the Vite dev server on
`0.0.0.0:5173`, and prints your LAN address. Everyone else on the network opens

```
http://<your-lan-ip>:5173
```

and connects automatically — the client defaults to `ws://<the host that served the page>:3000`,
so nobody has to type an IP. The connect panel lets you change the name and address, or
press **Play solo** to skip the server entirely.

Separately if you prefer: `npm run server` and `npm run dev`.

No port forwarding, no accounts, no matchmaking — LAN only, by design.

## Controls

| | |
|---|---|
| Click | capture mouse |
| WASD | move (camera-relative) |
| Shift | sprint |
| Space | jump |
| Mouse | look |
| LMB | shoot, or strike bare-handed if no weapon is drawn |
| **RMB** | **draw / put away the weapon you have selected** |
| **Scroll** | **switch weapon, when you are carrying more than one** |
| **E** | **pick up the weapon at your feet, or open / close the door you are standing at** |
| **G** | **throw away what is in your hands — empty-handed, it asks which one** |
| R | reload (respawn while dead) |
| F1 | show collision volumes — **shut doors are drawn in pink; an open one has no collider** |
| F2 | show hitboxes |
| **F3** | **show what the guards can see — vision cones and their line-of-sight rays** |
| **F4** | **show / hide your own allegiance (dev) — a toggle, not a permanent line** |
| F5 | cycle public role (dev) — changes speed, jump, stamina, health and body colour |
| F6 / F7 | give pistol / rifle (dev) |
| F8 | reset your health, every target, **and every guard and the General** (dev) |
| F9 | unstick (dev) |
| B / N / **V** / M | spawn a dummy target / cycle its role / **cycle the weapon in its hands** / clear them (dev) |
| Esc | release mouse |

The debug overlay's `net` line shows connection state, your player id, how many other
players you can see, round-trip time, and the last correction the server sent you.

## Roles and stamina

Physical stats are per public role (`src/shared/roles.ts`). Sprinting is the only thing
that drains stamina; empty it and you are locked to a walk until it recovers past a
quarter of the bar.

| Role | Health | Walk | Sprint | Jump apex | Sprint seconds | Empty → full |
|---|---|---|---|---|---|---|
| Security Officer | 200 | 4.0 | 7.0 | 1.17 m | 20 s | 14.3 s |
| Telegram Operator | 120 | 4.2 | 6.0 | 0.84 m | 12 s | 13.3 s |
| Doctor | 100 | 3.8 | 6.0 | 0.69 m | 10 s | 11.1 s |
| Secretary | 90 | 3.5 | 4.5 | 0.34 m | 10 s | 20.0 s |

## Combat

Bullet damage is **flat per weapon and hit class**. The bullet is the same bullet whoever
it hits; the differentiator is the target's health (`ROLE_STATS`), not the gun. The rifle is
exactly twice the pistol everywhere.

| damage | head | torso | limb |
|---|---|---|---|
| Pistol | 200 | 100 | 50 |
| Rifle | 400 | 200 | 100 |

Head damage sits above every role's max health, so a head shot is always a kill. What that
flat scale produces at the current HP values:

| shots to kill | HP | rifle head / torso / limb | pistol head / torso / limb |
|---|---|---|---|
| Security Officer | 200 | 1 / 1 / 2 | 1 / 2 / 4 |
| Telegram Operator | 120 | 1 / 1 / 2 | 1 / 2 / 3 |
| Guard (NPC) | 120 | 1 / 1 / 2 | 1 / 2 / 3 |
| Doctor | 100 | 1 / 1 / 1 | 1 / 1 / 2 |
| General (NPC) | 100 | 1 / 1 / 1 | 1 / 1 / 2 |
| Secretary | 90 | 1 / 1 / 1 | 1 / 1 / 2 |

This deliberately departs from CLAUDE.md §12, which wanted a pistol torso shot to always
take two and a limb to always take two. Under a flat scale a 100 HP Doctor dies to one
pistol torso round and to one rifle limb round. That is the direct consequence of "the
differentiator is in the character's stats" — if it plays badly the fix is to raise the
squishy roles' HP above 100, not to make the bullet care who it hits.

Six hit regions — head, torso, left/right arm, left/right leg — built from the same
`BODY_SEGMENTS` that build the visible body, so what you see is what you hit. **F2** draws them.

Anyone can fight bare-handed, at a fraction of a firearm's damage. Melee is per role:

| Role | Melee | Strikes to kill (best → worst target) |
|---|---|---|
| Security Officer | 30 | 3 – 7 |
| Doctor | 20 | 5 – 10 |
| Telegram Operator | 20 | 5 – 10 |
| Secretary | 15 | 6 – 14 |

Players also collide with each other, so a body can block a doorway or a corridor.

Concealment is an **absence, not a flag**: the snapshot carries only the weapon you are
visibly holding, or nothing. There is no wire shape that could express "hiding a pistol",
so no client can learn about one it cannot see. Your inventory is sent only to you, the same
way health is. `canBrandish(role, weapon)` in `src/shared/weapons.ts` is the single
authorization rule, and the guards' entire suspicion test is
`weaponVisible && !canBrandish(role, weapon)`.

## Weapons on the floor

One hand, a small bag behind it. **E** picks up whatever is at your feet, **RMB** draws it or
puts it away, **scroll** switches between what you carry, and **G** throws something away —
with a weapon in your hands that is the one that goes, and empty-handed it lists the bag and
asks. The prompt at the bottom of the screen always says which key does what right now.

Picking a weapon up **never draws it**: a Doctor who found a pistol and auto-brandished it
would be shot by a guard for a keypress he never made. Nor does scrolling — switching weapons
does not change whether anything is on show.

**A rifle is a metre of wood and steel and only the Security Officer can pick one up.** Anyone
else standing over one is told so instead of the pickup silently doing nothing
(`canCarry(role, weapon)` in `src/shared/weapons.ts`). Pistols go in anyone's pocket.

The dead drop what they carried, scattered where they fell. Kill the Security Officer and his
rifle *and* his pistol are lying there; kill a guard and his rifle is. That is the main way an
unarmed infiltrator gets armed, and it is loud — though only another Security Officer can make
use of the rifle.

A few hidden pistols are seeded into drawers and cabinets at round start, chosen from a longer
candidate list in `src/shared/mapData.ts`, so where they are is not learnable between rounds.

## Guards and the General

Seven guards and one General, living in `src/shared/npc.ts` — the same world the server ticks
and offline solo mode ticks, so solo testing exercises the real AI.

`PATROL → INVESTIGATING → SUSPICIOUS → WARNING → HOSTILE`. A guard notices exactly one thing:
someone doing something his public occupation does not license. He has to actually *see* it —
vision cone plus a real raycast against the compound walls — then 0.75 s of reaction delay,
then he closes to 5 m and shouts as proximity text every nearby human can read. Two seconds of
grace. Put it away and he stands down; carry on and he fires at 0.7 accuracy on a 1.1 s
interval, which is beatable if you run.

**Guards remember faces.** Anyone who was ever pushed to HOSTILE, or who ever shot at a guard,
is on that guard's list. Breaking line of sight no longer clears it: he walks to where he last
saw you and sweeps the area, and if you step back into view — empty-handed, hands up, whatever —
he re-engages immediately with no second warning. Dying is what clears it (`NpcWorld.forget`),
so one mistake does not mark a playtester for the rest of the round.

**Guards hear.** A gunshot carries 45 m and a landed punch 10 m. Patrolling guards break off
and go and look, sweep for a few seconds and then resume their route. Static posts do not, and
neither does the General's own detail — the men in that room are there for one reason, and a
noise elsewhere is not it, so the office cannot be emptied by ringing a doorbell across the map.

### Restricted areas

`RESTRICTED_ZONES` in `src/shared/mapData.ts`, judged by the single `offenceOf()` function, so
this is data rather than special cases in the AI:

| Zone | Who may be there | What happens to anyone else |
|---|---|---|
| The HQ door approach | Security Officer, Secretary | challenged, then shot if they stay |
| **Inside the General's office** | **Secretary, and only unarmed** | **shot on sight, no warning** |

Two sentries stand outside the door and a third watches it from inside. A weapon visible
anywhere in that office is instantly hostile whoever is holding it — including the Secretary
who is otherwise welcome, and including the Security Officer whose rifle is legal everywhere
else in the compound. So the Secretary can walk in with a pistol, provided nobody ever sees it.

You are told once, on the way in, when you enter somewhere you may not be. Being shot for
trespassing should be a rule you broke, not an ambush.

### Shooting a guard

The loud option. Every guard within `provokeRadiusOnKill` (60 m — the whole compound) turns on
the shooter, through walls; a wound carries 25 m. They still owe you one reaction delay before
the first bullet, so there is a beat in which to break line of sight — but now they remember
you afterwards. Both radii are tuning knobs in `GAME_CONFIG.guards`.

The General stands in his HQ — the only room in the compound reachable through a single door —
100 HP, the full six-region hitbox, and killing him broadcasts **THE GENERAL IS DOWN** to
everyone. It also ends the round: see below.

## Doors

Seven, one per room; the wide corridor junctions and hall openings have none, because they are
the compound's arteries. **E** toggles the nearest one within 2 m, and nothing closes on its
own — a door left open is a thing another player can read.

A shut door is a wall in every sense that matters: you cannot walk through it, a bullet does not
pass it, and a guard cannot see a brandished pistol through it. That last one is the interesting
part — a shut door is somewhere to draw a weapon out of sight.

Doors are deliberately **invisible to the nav grid**. The grid is built once at module load and
must keep seeing every doorway as open; if a shut door repartitioned the compound, guards would
stop being able to path anywhere. Instead **guards open doors they reach** — they have keys —
which keeps a closed door from cutting the compound in two while still making it a real obstacle
for players. `npm run test:doors` pins all of that, including that every leaf swings into its
room rather than into the corridor.

## The round

A round starts on its own once two players are connected, runs 15 minutes, and ends three ways:

- the **General is dead** → infiltrators win
- **every infiltrator is dead** → loyalists win
- **the clock runs out** → loyalists win, the General survived the day

Roles are dealt server-side on one shuffle and allegiances on a second, independent one — so the
Security Officer is not always a loyalist, which is the whole game (CLAUDE.md §2). One
infiltrator per four players, rounded up.

**Death is final while a round is running.** That is forced by the second win condition:
"every infiltrator is dead" can never be true if the dead come back in four seconds. It is a real
change to how a firefight feels, so it is a switch — `GAME_CONFIG.round.permanentDeath` — and
respawn works normally in the lobby and after the round is over either way.

Your allegiance is **never on screen** unless you press F4, and then only your own (CLAUDE.md
§30, §38). It is a toggle rather than a HUD line for a reason that has nothing to do with code:
at a playtest people sit next to each other. Structurally, no faction field exists on
`PlayerPublic` or `PlayerSnapshot`, so there is no broadcast one could ride on; the only message
that carries anybody else's is the end-of-round reveal, and by then there is nothing left to
deduce.

Solo, the client runs a thin version of the same round so one person can walk the win path
before a playtest: you are a loyalist, killing the General ends it, the clock running out does
not.

## The Security Officer's patrol

Every two to three minutes (jittered, so you cannot set a metronome by it) the compound expects
the officer in a named room — Storage, the Telegram Room, the Medical Ward, the Waiting Area,
the Admin Office or the Central Hall, never the same one twice running and **never the General's
HQ**. Standing in it for three seconds completes the patrol and schedules the next.

Miss the deadline and his **search ability switches off until he gets there** — the checkpoint
does not roll over, and arriving always gives the ability back, however late he is. CLAUDE.md
§15 is explicit that this is temporary and never permanent, and `npm run test:duty` pins it:
lapse, recover, lapse again, recover again.

The point is not the walk. It is that an officer who camps beside the General for the whole
match is visibly neglecting his job, and the other players get to notice that by watching where
he is — which is why the patrol line appears on his screen and on nobody else's.

Search itself is not in this pass. The flag exists, is enforced, and is displayed, ready for it.

## Sound

`assets/sounds/` — pistol and rifle reports, a random one of three punch impacts per melee hit,
a pickup click and a landing thud. Positional, so distant shots are quieter and you can tell
whether the shooting is in this corridor or the next one. Browsers refuse audio until the first
user gesture, so it comes up when you capture the mouse.

## Multiplayer model

Hybrid authority, as agreed in the plan:

- **The client owns its own movement.** It simulates locally and reports position at 30 Hz.
  The server never re-simulates — re-simulating without rollback would fight client
  prediction and wreck the movement feel, which is the thing this prototype exists to test.
- **The server refuses the impossible.** Out of bounds, or faster than that role's sprint
  speed (× 1.6 tolerance, plus slack for jitter) → it replies with a `correction` and the
  client snaps back. `teleport` is the explicit escape hatch for respawns and the F9 unstick,
  and it is still here — what milestone 5 did take over is **round spawning**: the server
  picks the spawn point at the start of a round and sends `spawned`, so where everyone begins
  a match is not the client's decision.
- **The server owns combat.** The client sends only "I fired this weapon from here, this
  way"; the server checks the origin is near where that player actually is, raycasts against
  its own hitboxes and walls, and decides the region and the damage. Health is sent only to
  its owner. The client draws the tracer immediately for feel, but the server's answer is
  what counts. Offline (solo) mode runs the same shared resolver locally against debug bots.
- Remote players are drawn 80 ms in the past, interpolated between 30 Hz snapshots against a
  render clock locked to the server clock. Losing two snapshots in a row is invisible.
- **Faction never touches the wire.** `src/shared/net.ts` has no field for it, only the
  public role. Name tags use `depthTest`, so a label behind a wall is hidden — a
  see-through tag would be a free wallhack in a hidden-role game.

## Where things live

- `src/shared/mapData.ts` — **the compound.** Rooms, walls, props, spawns, guard posts,
  `RESTRICTED_ZONES`. Edit the map here;
  rendering, collision, guard line-of-sight and shot occlusion are all derived from it, so they can
  never disagree.
- `src/shared/constants.ts` — every tuning value that is the same for everyone (`GAME_CONFIG`):
  gravity, accel/decel, collision sizes, camera.
- `src/shared/roles.ts` — per-role stats: health, walk/sprint speed, jump, stamina, body colour.
- `src/shared/collision.ts` — capsule-vs-AABB movement, body-vs-body push-out, and
  raycasting. Pure math, no three.js, so the server runs the same code for hitscan.
- `src/shared/hitbox.ts` — `BODY_SEGMENTS` (the one source of body proportions, used by both
  the visible mesh and the hitboxes) and the six-region character raycast.
- `src/shared/combat.ts` — `resolveShot` / `resolveMelee` / `damageFor`. Both the server and
  offline mode call these, so solo testing exercises the real rules.
- `src/shared/weapons.ts` — weapon stats, `canBrandish(role, weapon)` (may you be *seen* with it)
  and `canCarry(role, weapon)` (may you pick it up at all).
- `src/shared/npc.ts` — the guards and the General: patrol, vision, escalation, shooting.
  `NpcWorld` is ticked by the server, and by the client when you play solo.
- `src/shared/net.ts` — the wire protocol. One typed message union, imported by both sides.
- `src/server/server.ts` — socket + LAN address printing. `GameServer.ts` — the session:
  join/leave, validation, 20 Hz snapshots. `PlayerState.ts` — the move check.
- `src/client/net/Connection.ts` — transport only, knows nothing about the game, so Steam
  networking could replace it later without touching gameplay.
- `src/client/player/RemotePlayer.ts` — snapshot buffer + interpolation for other players.
- `src/client/` — rendering, input, camera, HUD, debug overlay.

## Compound topology

Every room is a single-door dead end; the corridors and the Central Hall are the only
connective tissue. **The General's HQ has exactly one door**, off the north corridor, so
every approach to the General is observable and the corridor is a real chokepoint.
Admin, Waiting, Telegram and Medical each open onto an outer corridor; Security and
Storage each open onto the Central Hall.

## Verified behaviour

**Milestone 1** — walk and sprint hit their configured speeds exactly for all four roles;
jump apexes match the table with no double jump; stamina forces a walk after exactly the
configured sprint duration and blocks sprinting until it recovers; stop distance 0.25 m;
walls, props and the perimeter all block; diagonal input is normalised; sliding along
walls does not stick; 0.35 m ledges are stepped up and back down without leaving the
ground; 0.55 m obstacles correctly block. A 0.2 m-grid flood fill from spawn reaches
**every walkable cell of all 13 rooms** — no room is sealed and there are no dead pockets.

**Milestone 2**, checked with two real browser clients driven against the real server:
both connect and see each other with the correct name and public role; a standing player
is drawn at exactly the position the other client reports (0.000 m error); a walking
player is tracked continuously at ~0.7 m behind at 4 m/s — the expected 120 ms
interpolation delay plus snapshot quantisation — in even steps with no stalls or
rubber-banding; a fabricated `state` message claiming an unreachable position is rejected
with `moved too fast` and snapped back, while a legitimate respawn teleport is accepted
with no correction; disconnecting removes that player from everyone else's world. No
console errors on either client.

**Milestone 3**, checked twice — once headless in Node against the shared resolver
(`npx tsx scripts/combat-matrix.ts`), once by driving the real client in a browser:

- The full §37 matrix. Every role × {rifle, pistol} × all six regions gives exactly the
  intended hits-to-kill, at the current HP values and at any others.
- A ray aimed at each hitbox centre comes back as that region — the hit regions are where
  the body is drawn.
- A shot through a compound wall hits the wall; the identical shot with the geometry
  removed hits the body. Cover works.
- Melee reaches 1.5 m, misses at 5 m, misses behind the attacker, and does not hit a corpse.
- Sprinting into another body is stopped at 0.70 m — exactly two radii — and travel is
  unaffected with nobody there or with a body 3 m below.
- In the browser: aimed rifle head and torso shots each kill in one; a wall between shooter
  and target stops the shot; a Secretary punches a Doctor down in 7 strikes. No console errors.
  (The hits-to-kill numbers in that pass predate the flat damage scale above.)

One fix came out of that browser pass, and it is worth knowing about: the third-person
crosshair used to converge on the aim point only at maximum range, because it stopped at
walls but not at people. At 6 m an aimed headshot landed ~0.2 m low and hit an arm.
`CameraRig.focusPoint` now raycasts bodies as well as geometry, so the crosshair means what
it looks like it means at the distances this compound actually produces.

**Milestone 4**, checked the same two ways — `npm test` (the shared combat matrix plus the
mandatory §37 guard suite in Node) and a scripted browser session driving the real client:

- The §37 sequence, in full. Doctor standing in plain sight with empty hands → ignored.
  Doctor carrying a *concealed* pistol → ignored. Doctor brandishing it in view → challenged,
  and the challenge arrives as a shout with zero bullets in the first two seconds. Doctor who
  keeps holding it → hostile, 7 shots. Doctor brandishing **the same pistol behind a wall** →
  never noticed, guards stay on patrol. Security Officer openly carrying a rifle, or a pistol
  → ignored. Putting the weapon away de-escalates a guard who had already reached WARNING.
- Every guard patrol route is walkable at waist height with nothing to grind against.
- In the browser: six guards and one General spawn with meshes and tick; three hidden pistols
  are seeded onto the floor; **G** picks one up (and pointedly does *not* brandish it) and
  **G** puts it back; two rifle rounds kill a guard and his rifle lands on the floor next to
  him; the General dies to one rifle round and the compound is told; **F8** puts every NPC
  back on his feet. No console errors, three runs in a row.

Two real bugs came out of playing it rather than compiling it, both fixed:

- Picking a weapon up brandished it. `WeaponSystem.setInventory` reconciled the server's list
  by calling `give()`, which selects when your hands are empty — so an online pickup put a
  pistol openly in a Doctor's hand and a guard shot him for a keypress he never made. The
  reconciliation now restores whatever the hands were doing.
- Killing one sentry was instant, unavoidable death. `NpcWorld.provoke` set `mode = 'hostile'`
  by hand instead of going through `setMode`, which is the only thing that schedules
  `nextShotAt` — so every provoked guard's shot timer was already stale and the whole compound
  fired on the same frame the first round landed. There is now a reaction delay, and a
  regression test in `scripts/guard-tests.ts` that pins it.

**The restricted-area / memory / hearing pass**, checked the same two ways — `npm test` in Node
and `node scripts/browser-drive.mjs` driving the real client in a headless browser through
synthetic key, mouse and wheel events:

- **Rifles.** A Doctor standing over a rifle is told *"Rifle — only the Security Officer may
  carry this"* and **E** leaves it on the floor; a Security Officer picks up the same rifle,
  and picking it up does not put it on show.
- **Controls.** **E** takes the pistol at your feet concealed; **RMB** draws it and **RMB**
  again puts it away; **scroll** switches between two carried weapons and, when one is drawn,
  the new one stays drawn — switching is not a tell. **G** with a weapon in hand throws *that*
  one away with no menu; empty-handed with two in the bag it asks (`DISCARD: [1] Pistol
  [2] Rifle · [G] cancel`), **Escape** cancels with everything kept, and **[1]** discards
  exactly that weapon.
- **The office.** A Doctor reaching the HQ door gets `RESTRICTED — HQ APPROACH — TURN BACK`
  before anything else happens; stepping inside gets `GENERAL'S OFFICE — GUARDS WILL FIRE ON
  SIGHT` and a bullet 1.3 s later, with no warning stage in between. The unarmed Secretary
  walks into the same room and every guard stays on patrol.
- **Hearing.** Seven guards on patrol; one pistol shot from the south hall puts three of them
  into INVESTIGATING and leaves four — the door sentries and the office detail — on station.
- **Memory.** A Doctor brandishing a pistol in the north corridor is fired on; he conceals it,
  breaks line of sight and waits, and the compound goes quiet; he walks back into the same
  corridor empty-handed and is engaged again **0.2 s later with no second warning**. Respawning
  is what clears it.

No console errors in any of it. Two harness lessons worth keeping: the alerts only live four
seconds, so read them at the moment the line is crossed; and **R respawns, which is precisely
what forgives a grudge** — a memory test that presses it is testing nothing.

## Tests

```bash
npm test              # typecheck + every suite below
npm run test:combat   # the §37 damage matrix, every role × weapon × region
npm run test:guards   # the mandatory §37 guard reaction sequence, restricted areas,
                      # guard memory and guard hearing
npm run test:nav      # every room reaches every other room
npm run test:doors    # shut doors block movement, bullets and sight; guards open them;
                      # the nav grid never sees one; every leaf swings into its room
npm run test:round    # the three win conditions, and that no round message ever names
                      # a second player's allegiance
npm run test:duty     # patrol checkpoints are reachable, and a missed patrol disables
                      # search only until he gets there (§15)
npm run test:assets   # models and clips load at game scale, facing the game way, and
                      # the pistol's thin end points away from the player
```

And, with `npm run play` already running, the browser pass:

```bash
node scripts/browser-drive.mjs   # headless Chrome, real client, synthetic input
```

It writes screenshots to `.shots/`. Needs Chrome installed; it drives the page over CDP with
plain Node, no Playwright.

They run the same `src/shared/` code the server runs, not a copy of it.
