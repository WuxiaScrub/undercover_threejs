# NPC Behavior Specification

Engine-agnostic description of NPC behavior as reverse-engineered from the Three.js
prototype (`src/shared/npc.ts`, `src/shared/constants.ts`, `src/shared/mapData.ts`).
This document describes **behavior**, not code structure. Where the prototype's
behavior is ambiguous or looks accidental, it is marked **UNCERTAIN** or
**LIKELY ACCIDENTAL** rather than rationalised.

Format used throughout for each system:

- **Literal:** what the simulation actually computes.
- **Experience:** what a player at the keyboard perceives.
- **Verdict:** intentional and worth preserving, or not.

---

## 0. The cast

There are four kinds of NPC. They do not share a brain; they share a body and a
movement system.

| Kind | Count | Brain | Armed | Notes |
|---|---|---|---|---|
| **Guard** | 4–8 (roster remainder) | Full threat state machine | Rifle | The only NPC that judges, warns or shoots |
| **General** | exactly 1 | Cover-seeking, never attacks | Never | The assassination target |
| **Staff** (Doctor / Secretary / Telegram Operator) | 3 (one each) | Routine loop only | Never | No perception whatsoever |
| **Patient** | 2 | None at all | Never | Lie on ward beds; can die of neglect |

The single most important structural fact: **staff and patients have no threat
brain at all.** A Doctor NPC standing three metres from a man waving a pistol
does not react, does not flee, does not shout. This is deliberate (see
`NPC_DESIGN_PRINCIPLES.md` §2).

Health: guard 120, General 100, staff 80, patient 50.

---

## 1. What a guard can perceive

### 1.1 The perception payload

**Literal:** A guard is given, for each *player*, only: id, position, facing,
public role, alive/dead, the **openly held** weapon (or `null`), and an optional
`hqAccess` flag (only the Secretary can lose it, by missing deliveries). Nothing
else. There is no velocity, no crouch state, no "carrying something concealed"
field, no faction, no history.

**Experience:** Concealment is total and free. A pistol in your pocket is not a
"hidden pistol a guard might spot" — as far as the guard is concerned it does
not exist. Drawing it is a discrete, deliberate, fully-visible act.

**Verdict: intentional, preserve exactly.** This is the core of the concealment
mechanic: the player controls exactly one bit of information, and controls it
completely.

### 1.2 Sight

**Literal:** `canSee(guard, person)` is three tests, all of which must pass:

1. Horizontal distance ≤ **22 m** (`viewDistance`).
2. Horizontal angle to the target within **±0.45π ≈ ±81°** of facing
   (`viewAngle`, a ~162° cone — very wide).
3. An unobstructed ray from the guard's eye (**1.55 m**) to the target's chest
   (feet + **1.15 m**), tested against the *same* colliders the client renders,
   including **shut doors**.

There is no hearing of footsteps, no peripheral awareness, no "sixth sense".
Sight is binary; there is no partial or degraded detection at range.

**Experience:** Walls work. Doors work. Ducking round a corner *actually* breaks
contact. But the cone is so wide (162°) that "behind him" is a narrow ~198°
rear arc, and 22 m covers most of a corridor, so you cannot rely on flanking —
you rely on geometry.

**Verdict: intentional, preserve.** The mandatory prototype test
("Doctor brandishes pistol behind a wall → guard cannot react") depends on it.
The exact cone width is a tuning value, not a contract.

### 1.3 Hearing

Guards do not hear continuously. Noise is a **discrete event** pushed into the
world with a position and a radius:

| Event | Radius | Source |
|---|---|---|
| Gunshot (any gun, any shooter) | **45 m** | Essentially the whole compound |
| Landed melee strike | **3 m** | Only whoever is already in the room |
| Missed melee swing | — | Makes no noise at all |

**Experience:** Shooting anyone, anywhere, tells the entire compound something
happened. Beating someone to death is the *quiet* option, and that trade-off is
the entire reason melee exists in the prototype.

**Verdict: intentional, preserve — including the asymmetry.** A missed swing
being silent is a deliberate mercy.

A noise carries **no identity**. Guards learn *where*, never *who*.

---

## 2. What counts as an offence

**Literal:** Judgement is one pure function of one visible person, evaluated
fresh every tick. In priority order:

1. Standing inside a **restricted zone**:
   - `hq_interior` (the General's office, x −14…14, z −22…−12): allows only
     `secretary`; response **shoot**; also flagged no-weapons.
   - `hq_approach` (the corridor stub outside the door, x −3…3, z −12…−6):
     allows `security`, `guard`, `secretary`; response **warn**.
   - Inside such a zone, **any visible weapon at all** (even a Security
     Officer's legitimate rifle) → **shoot**, message *"Weapon! Put him down!"*.
   - Otherwise, a role not on the allow-list (or a Secretary whose `hqAccess`
     was revoked) → trespass, at the zone's response.
2. Anywhere else: a visible weapon carried by a role not authorised to carry it
   → **warn**, *"Put the weapon away!"*. Authorisation is centralised:
   only `security` and `guard` may be seen armed, with any weapon.
3. Otherwise: no offence.

Dead people are never an offence.

**Experience:** There are exactly two rules and everybody knows them: *don't be
seen holding a gun unless you're Security, and don't go in the General's
office*. A guard is a posted regulation, not a detective. Nothing else you do —
loitering, following someone, standing over a corpse, running — registers at all.

**Verdict: intentional, preserve the shape.** Note what is deliberately absent:
no suspicion score, no accumulation, no inference. Suspicion in this game is
supposed to live in the other *humans*, not in the AI.

**Important consequence:** severity is re-judged **every tick, including
mid-escalation**. A man being challenged in the corridor who steps through the
office door is immediately re-classified as shoot-on-sight; the warning ladder
does not carry across the threshold with him. This closed an exploit where you
could walk in behind a challenge and get two free seconds inside.

---

## 3. The guard escalation ladder

Full detail is in `NPC_STATE_MACHINE.md`. Behaviorally:

### 3.1 The `warn` path (visible weapon outside a zone)

1. **Notice.** The offence must be visible for a continuous **0.75 s**
   (`reactionDelay`) before anything happens. If the offence stops being visible
   the timer *drains* (at 1× real time), it does not reset — so flickering in
   and out of cover buys you time but doesn't fully reset the clock.
2. **Suspicious.** The guard shouts the offence line (nearby humans read it as
   proximity chat and hear a voice cue), abandons his route and closes at
   **3.2 m/s** — noticeably faster than his 2.0 m/s patrol.
3. **Warning.** Reached when he gets within **5 m** (`standoff`) *or* 3 s have
   passed in `suspicious`, whichever first. He shouts again and closes at half
   speed (1.6 m/s). This is the grace window.
4. **Hostile.** After **2.0 s** in `warning` (`warningDuration`). Entering
   hostile schedules the *first* shot one more **0.75 s** in the future.
5. **Fire.** A rifle shot every **1.1 s** while the target is visible and within
   rifle range (90 m), with **0.7 accuracy** (a small aim cone; guards miss).

**Total time from "guard first sees your pistol" to "first bullet leaves the
barrel", if you are already at point-blank range: ≈ 3.5 s.** From across a room
it is longer, because he has to walk to 5 m before the 2 s warning even begins.

**Experience:** You get shouted at, you get a couple of seconds of a man walking
at you with a rifle up, and *then* you get shot. It is survivable, and it is
survivable specifically because you were told. Putting the weapon away at any
point up to the moment he turns hostile ends it completely.

**Verdict: intentional, preserve the whole ladder.** The timings are tuning; the
*ordering* (shout before shot, and always a beat you can run in) is the contract.

### 3.2 The `shoot` path (restricted zones)

**Literal:** If the offence's response is `shoot`, the reaction delay drops to
**0.25 s** (`shootOnSightReaction`) and the guard skips `suspicious` and
`warning` entirely — straight to hostile, with the first shot scheduled just
0.25 s out.

**Experience:** Crossing the threshold of the General's office is not a
negotiation. It reads as *"the rule is posted, and everyone knew it"*. Being
challenged at the approach zone (warn) and executed one metre further north
(shoot) is a sharp, learnable, spatial line.

**Verdict: intentional, preserve.** The spatial discontinuity is the point: risk
should be a place on the map you can point at.

### 3.3 De-escalation

**Literal:** A guard stands down only if he can **currently see** the person and
that person is currently committing no offence — and only from `suspicious` or
`warning`, never from `hostile`. Complying by stepping behind a wall does not
count. On standing down from `warning` he shouts *"Carry on."*

**Experience:** You must holster **where he can watch you do it**. Ducking out
of sight reads as evasion, not compliance. And once he has actually opened fire,
there is no talking him down — that conversation was available and you skipped it.

**Verdict: intentional, preserve.** "Compliance must be witnessed" is one of the
best rules in the prototype.

---

## 4. Grudges (the memory system)

**Literal:** The moment a guard enters `hostile` toward a player, that player's
id is added to that guard's personal `grudges` set. From then on, whenever that
guard sees that player — this minute or ten minutes later, armed or not, behaving
perfectly or not — he goes **instantly hostile with no reaction delay and no
warning**, shouting *"There he is! Stop him!"*.

Grudges are:
- **Per-guard**, not shared. Guard A's grudge is not Guard B's.
- **Keyed to the player's id**, so they survive across rooms, states and time.
- **Never expired by time, distance or good behavior.**
- Cleared only by `forget(playerId)`, which the server calls on **respawn** and
  on **round start**.

Grudges are seeded from three places: reaching hostile yourself, being **shot**
(the victim guard needs no line of sight — he knows who shot him), and the
`provoke` broadcast (§5).

**Experience:** You are marked. Every subsequent encounter with that guard is a
gunfight you did not get to opt out of. Since `permanentDeath` is on for a live
round, `forget` never fires mid-round — so within a round a grudge is
**permanent**. Being killed is the only thing that settles the account, and in a
permanent-death round that ends your participation anyway.

**Verdict: intentional in shape, questionable in duration.** The comments say a
permanent shoot-on-sight mark would "take a playtester out of the round for
good" — which under `permanentDeath: true` is exactly what it does. See
`NPC_IMPLEMENTATION_NOTES.md` §4.1 for a recommended change.

---

## 5. Collective reactions (`provoke`)

**Literal:** When an NPC takes damage, every **guard** within a radius of the
victim who can see *either* the victim's position *or* the shooter's last known
position is turned hostile toward the shooter, given the shooter's grudge, and
sent to the shooter's position.

| Trigger | Radius | Line of sight required? |
|---|---|---|
| An NPC is **wounded** | 25 m | Yes |
| An NPC is **killed** | 60 m (the whole compound) | Yes |
| Door access violation (opening a door your role may not) | 25 m | Yes |
| Telegram Operator denounces a player | 200 m (i.e. unbounded) | Yes |

Guards promoted this way go through the normal hostile entry, so they each still
owe you a 0.75 s beat before their first shot.

**Experience:** You do not get to pick guards off one at a time in a corridor. A
*kill* is heard and acted on by everyone who can see the scene; a *wound* only
alarms the immediate area. But because line of sight is still required, killing
someone **round a corner, out of everyone's view** genuinely works — the guard
who couldn't see it investigates the noise instead of hunting you. The
prototype's own tests assert exactly this difference.

**Verdict: intentional, preserve — especially the LOS requirement.** It is what
makes the map matter for murder as well as for concealment.

**UNCERTAIN:** the 200 m denounce radius is described in the code as
"compound-wide shoot on sight", but because `provoke` still requires line of
sight, the practical effect is only "every guard who can currently see you or
your last known spot". The gap between the stated intent and the actual behavior
is unresolved. Decide deliberately in the port.

---

## 6. Noise response

**Literal:** On hearing a noise within its radius, a guard who is currently in
`patrol` or `investigating` does one of two things depending on whether he is
**posted**:

- **Posted** (his route is a single point, *or* his post is inside the
  shoot-on-sight zone): he **turns to face the noise for 4 s** and does not move
  one step. Then he returns to his post facing.
- **Mobile** (walks a multi-point circuit): he shouts *"What was that?"*,
  abandons his route and walks to the noise.

Guards already in `suspicious`/`warning`/`hostile` ignore noise entirely.

**Experience:** A gunshot pulls the patrols in and leaves the sentries where they
are. You cannot empty the corridor outside the General's office by firing a shot
in Storage — but you *can* pull the roaming guards away from wherever you want
to be. And a sentry with his back to you will turn round, so shooting at
someone's back from behind a static post is not the free action it once was.

**Verdict: intentional, preserve both halves.** Sentries who abandon posts turn
a noise into a lever for emptying the map; sentries who never turn are stoics
who let you shoot them in the back.

### 6.1 Investigation behavior

**Literal:** An investigating NPC walks to the noise (at approach speed, 3.2 m/s)
and, on arriving within **1.5 m**, stops and **sweeps his view cone across the
bearing he walked in on** — a sine sweep of ±1.2 rad (~±69°) at 1.1 rad/s. He
lingers **4 s** and then stands down and rejoins his route.

Two refinements matter:
- Multiple responders **spread out**: each guard walks to his own spot ~1.2 m
  from the noise (deterministically offset per NPC), so three men converging on
  one gunshot arrive on three headings instead of stacking in a doorway.
- The give-up deadline is `max(11 s, walking time + 4 s linger + 4 s slack)` —
  so a shot at the far end of the compound is still worth the walk, instead of
  being abandoned halfway there for no reason a watching player could infer.
- When a guard rejoins his patrol he rejoins at the **nearest waypoint by
  walking distance**, not the one that was next when he left.

**Experience:** A guard who heard something walks over, looks around properly in
the direction it came from, and goes back to work. He does not spin in place, he
does not stare at a wall, and he does not walk the length of the compound back to
where he was standing before. It reads like a person losing interest.

**Verdict: intentional, preserve the *feel*.** The sweep-across-approach-bearing
and the spread are both explicitly bug fixes for behavior that looked broken;
reproduce the outcome, not necessarily the maths.

---

## 7. Chasing and losing the target

**Literal:** While alerted, a guard:
- Faces the target every tick (turn rate **5 rad/s** — about 0.6 s to spin 180°).
- Walks toward the **target himself while visible**, and toward the
  **last known position** when not. He never beelines at a body he cannot see.
- Closes to **5 m** and stops there (straight-line range), *unless* the straight
  line is blocked, in which case he keeps pathing round — a guard who "arrives"
  through a wall would otherwise grind against brickwork.
- After **4 s** without sight (`loseSightAfter`) he converts the chase into an
  investigation of the last known position, looks around, then stands down.
  **The grudge survives this.**

**Experience:** Breaking line of sight for four seconds ends the immediate
pursuit, and you can hear it end — he stops shooting and goes to where you were.
But he has not forgiven you, and walking back past him later is fatal.

**Verdict: intentional, preserve.**

---

## 8. What guards do NOT react to

This list is as important as everything above.

| Not reacted to | Status |
|---|---|
| **Corpses.** A dead body is not an offence and nothing ever scans for one. | **Intentional but incomplete** — see below |
| **Deaths they did not see.** Witnessing is only the `provoke` broadcast at the moment of the shot. There is no "I found a body" behavior at all. | Same |
| **Other NPCs.** Guards only ever perceive *players*. An NPC can never be a suspect, and guards cannot shoot each other. | Intentional simplification |
| **Loitering, following, being somewhere odd.** | Intentional (that's the humans' job) |
| **Doors left open.** Open doors are a readable trace for *players*, not for guards. | Intentional |
| **Blood, dropped magazines, sounds of movement.** | Not modelled |

**On bodies:** the player-facing consequence is that a murder committed out of
everyone's sight is *permanently* undiscovered by the AI. The compound never
learns the Doctor is dead. That may well be the right prototype answer (it keeps
discovery a human responsibility) but it should be a **conscious** decision in
the Godot version, because the brief's phrase "reactions to bodies" currently has
no implementation to preserve.

**UNCERTAIN:** whether the absence of body-discovery is design or unfinished work.
Nothing in the code comments claims it as a decision.

---

## 9. Dropped weapons

**Literal:** A **calm** guard (patrol mode only, never mid-investigation) who has
a dropped *weapon* item within **8 m**, inside his view cone, with clear line of
sight to it on the floor, will walk to it at **patrol speed** (not urgently),
pick it up, and resume his route. He gives up after **12 s**. Picked-up weapons
join his carried inventory and drop again when he dies.

**Experience:** You cannot litter. Drop a pistol in a corridor and a passing
guard confiscates it. It also means killing an armed guard leaves a rifle *plus*
anything he's swept up on the floor.

**Verdict: intentional, preserve.** It is a small thing that makes the compound
feel maintained rather than static. Note it never triggers alarm — a gun on the
floor is litter, not evidence.

---

## 10. The General

The General reuses the guard's mode names for a completely different behavior.

**Literal:**

- **At his desk** (`patrol`): stands at (0, −21.2) facing the door. Each tick he
  scans for the nearest **armed** person who is **inside the shoot-on-sight zone**
  and in his line of sight. A rifle glimpsed out in the corridor is not his
  problem. After **0.75 s** of seeing one, he alarms.
- **In cover** (`investigating`): every **0.7 s** he re-picks the nearest cover
  spot in the room that the threat cannot see him from (scored by walking
  distance minus 0.35× distance from the threat, so he drifts to the far side of
  the room), runs there at **3.6 m/s** — deliberately slower than a sprinting
  player — and, once in position, stops and **faces the threat** so his own
  vision cone watches the doorway.
- **Bolting** (`hostile`): triggered when there is no hidden cover left, **or**
  he has taken **2 hits**, **or** — most importantly — the threat's last known
  position is **inside the office**. He then runs for the HQ door (i.e. toward
  his guards) and stops when he reaches it.
- **Calming down:** after **8 s** with no sign of the threat he walks back to his
  desk and resumes standing.
- He is **alarmed without seeing anything** by: any gunshot inside the office
  zone, any gunshot within **14 m** of him, being damaged, or one of his own
  detail going hostile inside the office.
- **He never has a weapon and never attacks. Ever.**

**Experience:** He is not a boss fight. He is a man who keeps a pillar between
himself and your muzzle, shuffling round it as you circle. Shooting *at* him and
missing still works as an alarm. Chasing him into the office makes him run for
the door — which is to say, toward four armed guards — so the naive plan of
"walk in and corner him" is the plan that gets you killed.

**Verdict: intentional, preserve.** The design goal is stated plainly: the
assassination should be about **access and angle**, not damage.

---

## 11. Staff routines

**Literal:** Staff walk a fixed, short loop of stops. Each stop has a position, a
dwell time, an optional ± jitter, and an optional facing. Dwell is
`max(1, seconds ± jitter)`. They start already dwelling at their first stop, so
the first thing a player ever sees them do is their job rather than a walk from
nowhere.

| Role | Loop | Timing |
|---|---|---|
| **Doctor** | Bedside (7.5, 5.5) → supply cabinet (12, 4.5) → **Storage (4.6, 23)** → ward desk (8, 9) | 25±5, 8±2, 12±4, 15±4 s |
| **Secretary** | Telegram room (−8, 5) → **General's desk (0, −17.5)** | 18±4, 20±5 s |
| **Telegram Operator** | Three consoles in the telegram room, x = −9.6, z = 4 / 7 / 10 | 150±30 s each |

**Experience — and this is the whole point:**

- The Doctor's **Storage run** is the window in which a *human* Doctor can be out
  of the ward without it looking odd. If the NPC Doctor never left the ward, a
  human Doctor going to Storage would not be suspicious — it would be
  *unprecedented*, and the social mechanic would collapse into a tell.
- The Secretary's **paper run** is the same errand the human Secretary's delivery
  duty demands, walked at the same pace on the same route. She is the only
  character who routinely walks through the HQ door, which is what makes a
  human doing it plausible.
- The Operator is effectively a **statue that twitches** — 2½ minutes per
  console. He establishes that "sitting still for minutes" is normal for that
  role.

**Verdict: intentional, preserve — this is arguably the most load-bearing NPC
system in the game.** The NPC roster exists to be a *baseline of normal* that
human players can hide inside and be judged against. Everything about the
roster (see §12) serves this.

---

## 12. The roster: NPCs as camouflage

**Literal:** Humans and NPCs are dealt from one list. Singleton roles (Doctor,
Secretary, Telegram Operator, Security Officer) are handed out first; whoever is
left over becomes a Guard. NPC seats fill whatever the humans didn't take
(6/7/8 NPCs for 2/3/4 players). An NPC Doctor and a human Doctor use the **same
model, the same clothes, the same nametag format**.

The nametag deliberately never exposes guard state: it shows only the label plus
`DEAD`, `*FLAGGED*`, or `SEARCHING`. **The only visible tell that a guard has
escalated is that he raises his rifle** (`aiming`, set for `warning` and
`hostile` only).

**Experience:** You cannot tell at a glance whether the Doctor across the hall is
a person or the simulation. You cannot tell whether the guard walking toward you
has decided to shoot until his rifle comes up. Both ambiguities are the game.

**Verdict: intentional, preserve — this is a hard requirement, not a nicety.**

---

## 13. Movement and navigation

**Literal:**

- Pathfinding is **A\*** over a uniform **0.5 m** grid baked from the static
  compound, with an octile heuristic, **no diagonal corner-cutting**, and
  string-pulling to remove redundant waypoints. Off-grid starts/goals snap to
  the nearest walkable cell within **2 m**.
- **Doors are deliberately absent from the nav grid.** The grid always sees the
  compound as if every door were open. Guards simply **push open any door within
  1.3 m** as they reach it — which is what a man with keys would do.
- The one restricted door (General's HQ) is only forced open by a guard who is
  **not in patrol mode** (i.e. actually chasing something) or by the **Secretary**,
  whose job is carrying paper through it. It auto-closes behind any NPC who
  leaves the office.
- Waypoint tolerances differ: **0.9 m** for patrol waypoints, but **0.35 m** for
  computed path waypoints — at the looser tolerance a guard cut the corner off a
  doorway, dropped the waypoint *inside* the doorway, and then walked straight
  at the next one through the adjacent wall.
- Paths are recomputed every **0.5 s**, or immediately if the goal has moved more
  than **1.5 m**.
- Movement uses the same collision solver as players, with gravity.

**Experience:** Guards use doors, go round corners, don't clip walls, and don't
take absurd routes. Doors visibly swing open ahead of them.

**Verdict: mechanism is an implementation detail (Godot has NavigationServer);
the *behaviors* to preserve are: doors don't block guards, the HQ door is only
opened by alerted guards and the Secretary, and it closes behind NPCs.**

### 13.1 Stuck handling

**Literal:** An NPC who is trying to move and is covering less than 35% of the
expected distance accumulates a stuck timer. At **0.6 s** the route is thrown
away and rebuilt from where he actually is — **and other bodies stop colliding
with him** (walls never stop colliding). At **2.5 s** the goal itself is
abandoned: investigators stand down, patrollers skip to the next waypoint.

**Experience:** Jams resolve themselves. The pathological case this fixes is the
General bolting for the door and being physically welded in place by his own
four bodyguards closing on the man chasing him.

**Verdict: the *stuck recovery* is essential and must be preserved in some form.
The specific mechanism of turning off NPC-vs-NPC collision is a hack** — two
NPCs briefly walking through each other is visible, but a General pinned to the
floor by his own detail is worse. Godot has better options (avoidance / RVO);
see `NPC_IMPLEMENTATION_NOTES.md` §3.

---

## 14. Randomness and variation

The prototype is **overwhelmingly deterministic**. The only randomness anywhere
in NPC behavior is:

1. **Routine dwell jitter** — ± a few seconds per stop, so the loops are not
   metronomes.
2. **Shot spread** — a random cone of half-angle `(1 − 0.7) × 0.14 ≈ 0.042 rad`
   (~2.4°) applied to each guard bullet.

Everything else — routes, decision thresholds, response spread offsets, cover
scoring — is fixed.

**Experience:** Patrol routes are learnable, and *meant* to be. You are supposed
to be able to time a guard's circuit. What you cannot predict is exactly when a
clerk stops working, and whether a given bullet hits you.

**Verdict: intentional, preserve the balance.** See
`NPC_DESIGN_PRINCIPLES.md` §1 — predictability is the resource the player plans
with; unpredictability is confined to the moment of violence.

---

## 15. Timing and constants reference

All values from `GAME_CONFIG` unless noted.

### Guards — perception
| Value | Setting |
|---|---|
| View distance | 22 m |
| View cone half-angle | 0.45π rad ≈ 81° (162° total) |
| Eye height / target height | 1.55 m / 1.15 m (chest) |
| Gunshot hearing radius | 45 m |
| Melee hearing radius | 3 m |

### Guards — escalation
| Value | Setting |
|---|---|
| Reaction delay (normal) | 0.75 s |
| Reaction delay (shoot-on-sight zone) | 0.25 s |
| `suspicious` → `warning` | at 5 m standoff, or after 3 s |
| Warning grace | 2.0 s |
| Delay before first shot after going hostile | 0.75 s (0.25 s in a zone) |
| Fire interval | 1.1 s |
| Accuracy | 0.7 (≈ 2.4° spread cone) |
| Lose-sight timeout | 4.0 s |
| Shout audible radius (to humans) | 20 m |

### Guards — movement
| Value | Setting |
|---|---|
| Patrol speed | 2.0 m/s |
| Approach speed | 3.2 m/s (halved in `warning`) |
| Turn rate | 5.0 rad/s |
| Patrol waypoint tolerance | 0.9 m |
| Path waypoint tolerance | 0.35 m |
| Repath interval / goal drift | 0.5 s / 1.5 m |
| Door open radius | 1.3 m |
| Stuck repath / give up | 0.6 s / 2.5 s |

### Guards — investigation
| Value | Setting |
|---|---|
| Arrival radius | 1.5 m |
| Linger | 4 s |
| Sweep rate / arc | 1.1 rad/s / ±1.2 rad |
| Responder spread | 1.2 m |
| Deadline | max(11 s, walk time + 4 s + 4 s) |
| Posted sentry look duration | 4 s |

### Guards — collective
| Value | Setting |
|---|---|
| Provoke radius on kill | 60 m (whole compound) |
| Provoke radius on wound | 25 m |
| Door violation radius | 25 m |
| Denounce radius | 200 m (unbounded; still LOS-gated) |

### Guards — items
| Value | Setting |
|---|---|
| Item sight radius | 8 m |
| Retrieve deadline | 12 s |

### General
| Value | Setting |
|---|---|
| Flee speed | 3.6 m/s |
| Cover refresh | 0.7 s |
| Cover standoff / min prop height | 0.4 m / 1.6 m |
| Hits before bolting | 2 |
| Calm-down time | 8 s |
| Alarm radius (gunshots) | 14 m |
| Confirmation delay before hiding | 0.75 s |

### Other
| Value | Setting |
|---|---|
| Melee stun applied to NPCs | 0.6 s |
| Search hold applied to NPCs | 15 s |
| Simulation rate (server) | 30 Hz |
| Max dt clamp | 0.25 s |
| Proximity chat radius | 12 m |

---

## 16. System interactions worth knowing

- **Concealment × perception.** Because concealment is an *absence* in the
  perception payload, no guard system anywhere can be made to notice a hidden
  weapon. Any Godot code that gives NPCs access to the full inventory
  reintroduces a whole class of bug.
- **Zones × the warning ladder.** Re-judging severity every tick is what makes
  the office threshold hard. If the port caches an escalation decision, the
  "walk in behind a challenge" exploit returns.
- **Grudges × permanent death.** Grudges are cleared only on respawn/round
  reset, and rounds have permanent death, so grudges are effectively permanent
  within a round.
- **Noise × posts.** Sentries turning but not moving is what stops noise being a
  lever to empty the HQ corridor. If sentries move, the assassination becomes
  trivial.
- **Provoke × line of sight.** LOS-gating the broadcast is what makes killing
  behind cover meaningfully different from killing in the open.
- **Stun × the whole brain.** A melee stun (0.6 s) or a search hold (15 s)
  freezes an NPC's *entire* brain including its mode timers. A guard stunned
  mid-warning resumes the warning where it left off, rather than the grace period
  ticking away while he is helpless. See `NPC_IMPLEMENTATION_NOTES.md` §4.3.
- **Guards × NPCs.** Guards never perceive other NPCs, so friendly fire and NPC
  suspects are impossible by construction.
