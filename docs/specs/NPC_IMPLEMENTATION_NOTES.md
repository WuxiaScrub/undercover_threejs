# NPC Implementation Notes for the Godot Rebuild

Practical notes for whoever reimplements these NPCs. Everything is sorted into
four buckets:

- **§1 — MUST PRESERVE.** Behavioral contracts. Changing these changes the game.
- **§2 — FREE TO REDESIGN.** Prototype-specific mechanisms with better Godot
  equivalents. The *outcome* matters, the method does not.
- **§3 — WORKAROUNDS.** Things that exist because of a Three.js-side limitation.
  Solve the underlying problem properly instead of copying these.
- **§4 — DO NOT NECESSARILY REPRODUCE.** Quirks, unresolved ambiguities and
  probable bugs. Each has a recommendation.

Then §5 collects the constants and §6 the tests worth porting.

---

## 1. MUST PRESERVE — behavioral contracts

These are asserted by the prototype's own test suites and/or named in the project
brief. Treat them as the acceptance criteria for the Godot NPCs.

### 1.1 Perception

1. A guard reacts **only** to what a person is *visibly* holding. The AI must
   never be given access to a concealed inventory. Model the perceived person as
   an explicit, minimal payload (id, position, facing, role, alive, **visible**
   weapon, access flag) rather than handing the AI the player node.
2. Detection requires **all three** of: within view distance, within the view
   cone, and an unobstructed ray from eye height to chest height.
3. The line-of-sight raycast must test against **the same geometry the player
   sees**, including **shut doors**. A door that looks shut must block sight.
4. Guards perceive **players only**. Guards must not be able to see, judge, or
   shoot other NPCs.

### 1.2 Judgement

5. Exactly two offence rules: (a) visibly carrying a weapon your public role may
   not carry; (b) being in a restricted zone your role may not enter. Nothing
   else.
6. Weapon authorisation must be **one centralised function**
   (`canBrandish(role, weapon)`), not scattered role checks. Currently: only
   `security` and `guard` may be seen armed, with any weapon.
7. **Any** visible weapon inside the shoot-on-sight zone is shoot-on-sight —
   including a legitimately armed Security Officer's.
8. The offence is **re-judged every tick**, including mid-escalation. An escalation
   decision must never be cached across a zone boundary.
9. **A dead person is never an offence.**

### 1.3 Escalation

10. Ordering is fixed: notice → shout → grace → shoot. A guard must never fire
    before shouting.
11. There must be a runnable beat between the decision to shoot and the first
    shot, in *both* the normal (0.75 s) and shoot-on-sight (0.25 s) paths.
12. Restricted-zone offences skip `suspicious` and `warning` entirely.
13. De-escalation requires the guard to **currently see** the person committing no
    offence. Breaking line of sight does not de-escalate.
14. `hostile` has no de-escalation. Complying after fire is opened does nothing.
15. Losing sight for the timeout converts pursuit into an investigation of the
    **last known position**, not an instant forget. A guard must never walk
    straight at a body he cannot see.

### 1.4 Collective response

16. Being shot makes the **victim** hostile toward the attacker with **no line of
    sight required** — he knows who shot him.
17. The `provoke` broadcast to *other* guards **requires line of sight** to the
    victim's or shooter's position. Killing behind a wall must not aggravate
    guards who could not see it.
18. A **kill** provokes at a much larger radius than a **wound**.
19. Guards promoted by a broadcast still owe the reaction beat before firing (the
    whole compound must not fire on the same frame).

### 1.5 Noise

20. Noise carries a position and a radius, never an identity.
21. Gunfire is loud (compound-scale); a landed melee hit is barely audible; a
    missed swing is silent.
22. **Posted sentries turn toward a noise but never leave their post.** Mobile
    patrols investigate. This distinction is load-bearing for the assassination
    design.
23. Guards already in an alerted state ignore noise.

### 1.6 Memory

24. Reaching `hostile` adds a **per-guard, per-player** grudge.
25. A grudged player is engaged **instantly on sight, with no delay and no
    warning**, regardless of what they are doing.
26. Grudges are not shared between guards.
27. Grudges survive losing the target and the subsequent investigation.

### 1.7 The General

28. He never has a weapon and never attacks, in any state.
29. He hides behind cover chosen by *the threat's* line of sight, and re-picks it
    as the threat moves.
30. He **bolts toward his guards** (the HQ door), not into open space, when
    cornered — where "cornered" includes *the threat is inside the office*.
31. He is alarmed by gunfire near him even with no damage and no sighting, so
    shooting *at* him and missing still counts.
32. He returns to his desk once things go quiet.

### 1.8 Staff and roster

33. Staff NPCs have **no threat brain**: they never become suspicious or hostile,
    never look at anyone, never investigate. (The unattended test asserts this.)
34. The Doctor's routine **must include leaving the ward** (the Storage run).
35. The Secretary's routine **must include walking through the HQ door** to the
    General's desk.
36. The Telegram Operator **never leaves the telegram room**, but does move
    between consoles.
37. NPC and human characters in the same role must be **visually and behaviorally
    indistinguishable**.
38. **Nothing in the UI may reveal a guard's internal state.** The nametag shows
    only the label plus DEAD / *FLAGGED* / SEARCHING. The **only** escalation tell
    is the raised rifle (set for `warning` and `hostile` only).

---

## 2. FREE TO REDESIGN — mechanism, not behavior

### 2.1 Pathfinding

The prototype uses a hand-written A\* over a 0.5 m uniform grid with an octile
heuristic, no diagonal corner-cutting, string-pulling, a 2 m snap radius for
off-grid points, a 0.5 s repath interval, and a 1.5 m goal-drift trigger.

**In Godot:** use `NavigationServer3D` / `NavigationAgent3D` with a baked
NavigationMesh. None of the grid parameters need to survive. What must survive:

- Guards go **round** obstacles rather than into them.
- Two waypoint tolerances are worth keeping conceptually: patrol waypoints can be
  loose, but **path** waypoints must be tight. The prototype's 0.9 m/0.35 m split
  exists because a loose tolerance let a guard drop a waypoint *inside a doorway*
  and then head for the next one through the adjacent wall. Godot's agent
  handles this better, but verify it in doorways specifically.
- A fallback when no path exists: the prototype walks the straight line, so a
  pathfinding gap makes an NPC clumsy rather than catatonic. Keep some fallback.

### 2.2 Doors

The prototype keeps doors **out** of the navigation graph entirely and has guards
push open any door within 1.3 m as they reach it. This is a workaround for
having a single statically-baked grid: a shut door in the grid would repartition
the compound and strand guards on the wrong side.

**In Godot:** use navigation links / obstacles and let doors actually be
navigable state. But preserve the *behavior*:

- Guards open ordinary doors freely as they walk into them.
- The **restricted** HQ door is only opened by a guard who is **alerted** (not on
  patrol) or by the **Secretary**. A guard on his rounds leaves it alone, because
  the door only means anything while it is shut.
- The HQ door **closes behind any NPC who leaves** the office.
- Doors left open by *players* stay open — they are a readable trace.

### 2.3 Collision and movement

Shared capsule-vs-box collision with players, plus gravity. Godot's
`CharacterBody3D` covers this. Keep NPC and player collision using the *same*
system so an NPC cannot walk somewhere a player cannot.

### 2.4 Shooting

Hitscan from eye height at the target's chest, with a random spread cone derived
from an `accuracy` value, resolved against per-region hitboxes. Reimplement with
Godot raycasts; keep hit regions and keep guards **beatable** (they miss).

### 2.5 Snapshot / network layer

The whole `NpcSnapshot` → client-interpolation path is Three.js-specific. Godot's
MultiplayerSynchronizer replaces it. Two things to carry over:

- The presentation layer eases toward the authoritative pose rather than
  simulating; NPC movement is not frame-critical.
- The snapshot deliberately **omits** the guard's mode. Keep the replicated state
  minimal so it is impossible to accidentally leak escalation state to clients.

### 2.6 The "shared brain" architecture

The prototype runs the identical NPC world on the server and inside the client in
offline solo mode, so one person can run the mandatory guard test alone.

**Strongly recommended to preserve the capability**, not the specific structure:
keep the NPC logic in a node/resource that can be instantiated headlessly, so the
routine and guard tests (§6) can run without a server or a renderer.

---

## 3. WORKAROUNDS — solve the real problem instead

### 3.1 Jammed NPCs stop colliding with each other

**What it does:** an NPC who has been failing to move for **0.6 s** has
NPC-vs-NPC collision disabled until he moves again (walls still collide). At
**2.5 s** he abandons the goal outright.

**Why it exists:** the General bolting for the door was reliably pinned in place
by his own four bodyguards converging on the man chasing him — welded to the
floor with no way through any of them. Nothing in the prototype steers around a
crowd.

**Player-visible effect:** NPCs occasionally walk through each other. That was
judged the lesser evil.

**In Godot:** this is what `NavigationAgent3D`'s avoidance (RVO) is for. Use it,
and you probably do not need the collision-disabling hack at all. **But keep the
give-up-after-N-seconds behavior** — abandoning an unreachable goal and doing the
next thing is a real behavior worth having, and it is the difference between "a
guard lost interest" and "a guard is broken".

### 3.2 The two-tier waypoint tolerance

See §2.1. This is a grid artefact. Verify Godot doorway traversal instead of
copying the numbers.

### 3.3 The straight-line pathfinding fallback

A defensive measure for grid gaps. Godot's navmesh should not need it, but a
fallback of some kind is still worth having so a navigation failure degrades
gracefully.

### 3.4 Responder spread offsets

Investigating guards each walk to a personal spot ~1.2 m from the noise so they
don't stack up in a doorway. With proper avoidance this may be unnecessary — but
check, because the *arrival pattern* (three men approaching on three headings) is
visibly better than a queue, and avoidance alone may still produce a queue.

---

## 4. DO NOT NECESSARILY REPRODUCE — quirks, ambiguities and probable bugs

### 4.1 Grudges are effectively permanent within a round

**What happens.** Grudges never expire — not by time, not by distance, not by
good behavior. They are cleared only by `forget(playerId)`, which fires on player
respawn and round start. Rounds run with `permanentDeath: true`, so **`forget`
never fires during a live round**. One escalation therefore marks you for the
remaining fifteen minutes, with the only "recovery" being death.

**Is it intentional?** Partly. The code comment says a permanent shoot-on-sight
mark "would take a playtester out of the round for good" — which is exactly what
it does under permanent death. The comment appears to predate that setting.
**This is a genuine internal contradiction, not a design statement.**

**Recommendation for Godot:** keep the grudge mechanic (§1.6) but give it a
**decay** — either a timeout (a few minutes) or a "clean sighting" condition
(seen behaving normally N times / for N seconds de-escalates to a heightened
reaction rather than instant fire). The principle worth preserving is *escalation
has a lasting cost*, not *escalation is unrecoverable*.

### 4.2 There is no reaction to corpses or discovered deaths

**What happens.** `offenceOf` returns null for the dead, nothing scans the world
for bodies, and no NPC has any "found a body" behavior. Witnessing exists only as
the `provoke` broadcast fired at the instant damage lands. A murder committed out
of everyone's sight is **permanently** undiscovered by the AI. The compound never
learns the Doctor is dead.

**Is it intentional?** **UNCERTAIN.** No comment claims it as a decision. It may
be a deliberate "discovery is the humans' job" call, or simply unbuilt.

**Recommendation for Godot:** decide explicitly. Both answers are defensible:
- *Keep it absent* — discovery stays a purely social act, which fits §11 of the
  design principles.
- *Add a minimal version* — a guard who walks within a few metres of a corpse in
  line of sight begins an investigation at that spot (not a grudge, not an
  accusation, since he cannot know who did it). This preserves "guards are not
  detectives" while making hiding a body matter.

Do not add anything that lets the AI *identify the killer* from a body.

### 4.3 A stun freezes the entire brain, including mode timers

**What happens.** While stunned, an NPC is skipped completely: no perception, no
movement, and **no timers advance**. A guard stunned mid-`warning` resumes with
the same 2 s grace remaining. A guard held in a 15 s Security search resumes his
escalation exactly where it stood 15 seconds ago.

**Is it intentional?** **UNCERTAIN.** Probably fine — arguably correct, since a
man being held cannot be counting down your grace period. But it is not stated
anywhere, and the 15 s search hold in particular is long enough that the resumed
escalation may read as bizarre to a player who thought the situation had ended.

**Recommendation:** make the choice explicitly. Reasonable alternative: keep the
freeze, but have a guard who is stunned or searched for longer than the lose-sight
timeout **stand down** to `investigating` rather than resuming a challenge.

### 4.4 `stun()` schedules against the *previous* tick's clock

**What happens.** `stun(id, seconds)` computes its expiry from a cached `nowMs`
set at the start of the last tick, not from the current time. At 30 Hz the error
is under 33 ms.

**Verdict: harmless artefact of the shared-brain design.** Do not reproduce the
pattern; just use the current time.

### 4.5 NPC guards fill posts in reverse order, so some circuits are usually empty

**What happens.** `reset()` deals NPC guards to **HQ posts first**, then to field
posts in **reverse** order — deliberately, so that human Guards (spawned from the
near end of the same list) do not collide with them. With a typical roster this
means the **chokepoint** and the **west/east circuits** are frequently unmanned
by NPCs.

**Is it intentional?** The *reversal* is intentional and commented. Its
consequence — that the compound's most important circuit (the chokepoint, which
covers the approach to the General) is usually NPC-empty — appears to be an
unexamined side effect.

**Recommendation for Godot:** keep the collision-avoidance intent, but make post
priority explicit and ordered by *importance* rather than by array position.
Check which posts are actually manned at each roster size and decide deliberately.

### 4.6 The denounce radius overstates its effect

**What happens.** The Telegram Operator's denounce calls the provoke broadcast
with a 200 m radius (effectively unbounded), described as compound-wide
shoot-on-sight. But `provoke` still requires line of sight, so the actual effect
is only "every guard who can currently see the accused's position".

**Verdict: UNCERTAIN whether the code or the comment is right.** Decide
explicitly in the port. If a denunciation is meant to be compound-wide
intelligence, it needs its own path that bypasses line of sight; if it is meant
to be local, the radius should say so.

### 4.7 The `suspicious` → `warning` 3-second fallback

Promotion happens at 5 m standoff **or** after 3 s, whichever first. The second
clause exists so a guard who cannot physically reach the target still escalates.
Whether the intended reading is "he loses patience" is not documented. Harmless
either way, but be aware it means a guard can challenge you from across a room.

### 4.8 The reaction timer drains rather than resetting

If the offender goes out of sight, `seenFor` decreases at 1× real time instead of
resetting to zero. Flickering in and out of cover therefore accumulates progress
toward escalation more slowly than staying visible, but does not fully reset it.

**Verdict:** almost certainly intentional smoothing, and it behaves sensibly. Not
documented as a decision. Worth reproducing.

### 4.9 A "Threat neutralised" shout fires without a flag

The one-shot shout on a target's death relies on the fact that `standDown` moves
the guard into `patrol`, and the patrol branch returns before reaching that code
again. It works, but it is a control-flow accident rather than a guard.
**In Godot, use an explicit flag or signal.**

### 4.10 Guards never shoot NPCs, so friendly fire is impossible by construction

Guards perceive players only, and `shoot` resolves against the player list. This
is a simplification, not a physics rule — an infiltrator can never trick guards
into killing each other or a staff NPC. Probably right for the prototype; be
aware you are choosing it again if you replicate the perception payload.

---

## 5. Constants

Group these in a single tuning resource, as the prototype does. Values are
starting points, not balance.

```
GUARD PERCEPTION
  view_distance ................. 22.0 m
  view_cone_half_angle .......... 0.45 * PI rad  (~81°, so a 162° cone)
  eye_height .................... 1.55 m
  target_chest_height ........... 1.15 m
  gunshot_hear_radius ........... 45.0 m
  melee_hear_radius .............  3.0 m

GUARD ESCALATION
  reaction_delay ................  0.75 s
  shoot_on_sight_reaction .......  0.25 s
  suspicious_fallback_promote ...  3.0 s
  standoff ......................  5.0 m
  warning_duration ..............  2.0 s
  fire_interval .................  1.1 s
  accuracy ......................  0.7    (spread half-angle = (1-a)*0.14 rad)
  lose_sight_after ..............  4.0 s
  shout_radius .................. 20.0 m   (audible to human players)

GUARD MOVEMENT
  patrol_speed ..................  2.0 m/s
  approach_speed ................  3.2 m/s   (halved while in WARNING)
  turn_rate .....................  5.0 rad/s
  waypoint_reach ................  0.9 m
  path_waypoint_reach ...........  0.35 m
  repath_interval ...............  0.5 s
  repath_goal_drift .............  1.5 m
  door_open_radius ..............  1.3 m
  stuck_repath_after ............  0.6 s
  stuck_give_up_after ...........  2.5 s

GUARD INVESTIGATION
  investigate_reach .............  1.5 m
  investigate_linger ............  4.0 s
  investigate_timeout ........... 11.0 s   (floor; deadline scales with walk time)
  investigate_slack .............  4.0 s
  investigate_sweep_rate ........  1.1 rad/s
  investigate_sweep_arc .........  1.2 rad
  investigate_spread ............  1.2 m
  alert_look_duration ...........  4.0 s   (posted sentry turning)

GUARD COLLECTIVE
  provoke_radius_on_kill ........ 60.0 m   (the whole compound)
  provoke_radius_on_hit ......... 25.0 m
  door_violation_radius ......... 25.0 m
  denounce_radius ...............200.0 m   (see §4.6)

GUARD ITEMS
  item_sight_radius .............  8.0 m
  item_retrieve_deadline ........ 12.0 s

GENERAL
  flee_speed ....................  3.6 m/s  (slower than a sprinting player)
  cover_refresh .................  0.7 s
  cover_standoff ................  0.4 m
  cover_min_height ..............  1.6 m
  hits_before_bolting ...........  2
  calm_after ....................  8.0 s
  alarm_radius .................. 14.0 m
  confirm_delay_before_hiding ...  0.75 s   (reuses reaction_delay)

HEALTH
  guard ......................... 120
  general ....................... 100
  staff .........................  80
  patient .......................  50
  (players: security 200, guard 140, telegram 120, doctor 100, secretary 90)

STUN
  melee_stun ....................  0.6 s
  search_hold ................... 15.0 s

WORLD
  simulation_rate ............... 30 Hz  (max dt clamp 0.25 s)
  proximity_chat_radius ......... 12.0 m
  player_radius / height ........  0.35 m / 1.8 m
  gravity ....................... 18.0 m/s²
```

### 5.1 Map data to carry over

| Thing | Value |
|---|---|
| General's desk | (0, −21.2), facing yaw = π |
| HQ door | (0, −12) |
| `hq_interior` zone | x −14…14, z −22…−12 — allows `secretary` only, response **shoot**, no weapons |
| `hq_approach` zone | x −3…3, z −12…−6 — allows `security`/`guard`/`secretary`, response **warn** |
| Patient beds | (5.5, 4) and (5.5, 7), bed height 0.6 m |

Guard posts (4 HQ + 7 field). HQ: door sentry W (−2, −10.2) and E (2, −10.2)
both facing south; HQ sentry (3.5, −18.5); HQ patrol, a 5-point loop of the
office. Field: chokepoint (north corridor + cross corridor), west circuit, east
circuit, south circuit, hall circuit, ward post (9.5, 5), signals post (−8.5, 5).
The two "post" entries are single-point sentries; the rest are circuits.

Staff routines are in `NPC_STATE_MACHINE.md` Part 3.

---

## 6. Tests worth porting

The prototype has two headless suites that between them encode most of the
behavioral contract. Porting equivalents to Godot (as headless scenes or GUT
tests) is the cheapest way to know the rebuild is faithful.

### 6.1 Guard reactions (the mandatory test from the brief)

- Doctor in plain sight, hands empty → ignored.
- Doctor with a **concealed** pistol → ignored (nothing to notice).
- Doctor **brandishing** in view → challenged, **and no shot in the first 2 s**.
- Doctor who keeps brandishing → hostile, and fires.
- Doctor brandishing the same pistol **behind a wall** → never noticed.
- Security Officer openly carrying a rifle **or** pistol → ignored.
- Guard escalates, then **stands down when the weapon is put away**.
- Unarmed Doctor at the HQ **approach** → challenged, not shot.
- The same Doctor **inside** HQ → shot within ~0.6 s, and no guard is still in
  WARNING once he is inside.
- Secretary walks her route untouched — but is shot with **no warning** if her
  pistol is drawn.
- Security Officer with a rifle **inside** the office → shot anyway.
- Killing a sentry turns other guards hostile.
- Nobody fires inside the reaction delay; everybody fires after it.
- A guard pushed to hostility **remembers the face** and re-engages on sight with
  no second offence. Being killed clears the grudge.
- A gunshot **pulls patrolling guards** to it, and they **return to their rounds**.
- A **posted sentry turns** toward a noise **without taking a step**.
- A kill **behind a wall** gives a bystander guard no grudge (he investigates
  instead); a kill **in the open corridor** does.
- The General: leaves his desk when shot at, is **out of the shooter's sightline
  within ~3 s**, never raises a weapon, bolts when the threat is inside the office
  or after 2 hits, and returns to his desk when it is over.

### 6.2 Ten unattended minutes of the compound

Run the whole roster for ten simulated minutes with **no players**, then assert:

- **Every waypoint and routine stop is standable** — i.e. has positive clearance
  from all solids. A stop inside a crate satisfies a chest-height raycast and can
  never satisfy an arrival radius, so the NPC grinds against it forever while
  still cheerfully reporting a normal state.
- The **Doctor spends time in the ward and also reaches Storage**, with the ward
  still being where he mostly is.
- The **Secretary visits the telegram room and reaches the General inside HQ**
  (which is also the check that a staff NPC can get through the HQ door).
- The **Telegram Operator never leaves the telegram room** but does move.
- **No staff NPC ever becomes suspicious or hostile.**
- **Nobody grinds:** no NPC travels more than a few metres while staying inside a
  1.5 m box. (Standing still is fine — several posts are sentries; the signature
  of a stuck NPC is *distance travelled inside a tiny bounding box*.)
- **Every guard started on a real post**, and every guard given a **circuit walked
  it** (matched to the post he started on, not assumed by index).
- **Nobody has been squeezed through a wall** — everyone is still inside the
  compound bounds.

These two suites catch, respectively, the design contract and the class of
navigation bug that is invisible until someone watches an NPC for five minutes.
