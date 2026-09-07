# NPC State Machine

Companion to `NPC_BEHAVIOR_SPEC.md`. This document is the precise, mechanical
description of NPC states, transitions, timers and thresholds — enough to
reimplement the machine without reading the Three.js source.

Three separate machines share one set of state *names*:

- **Guard** — the full ladder. This is what "the NPC state machine" normally means.
- **General** — reuses the same three names for entirely different behavior.
- **Staff** — a two-phase routine loop; never leaves the equivalent of `patrol`.
- **Patient** — no machine at all.

A **fourth, orthogonal condition** applies to every NPC: **stunned**.

---

## Part 1 — The Guard

### 1.1 States

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                                          │
   ┌──────────┐  noise   ┌───────────────┐                     │
   │  PATROL  │─────────▶│ INVESTIGATING │                     │ stand down
   │          │◀─────────│               │                     │ (comply /
   └────┬─────┘  done    └───────┬───────┘                     │  target gone /
        │                        │                             │  gave up)
        │  offence seen 0.75 s   │  offence seen 0.75 s        │
        ├────────────────────────┤                             │
        ▼                        ▼                             │
   ┌────────────────────────────────────┐                      │
   │           SUSPICIOUS               │──────────────────────▶│
   └────────────────┬───────────────────┘                      │
                    │ within 5 m, or 3 s elapsed               │
                    ▼                                          │
   ┌────────────────────────────────────┐                      │
   │            WARNING                 │──────────────────────▶│
   └────────────────┬───────────────────┘                      │
                    │ 2.0 s elapsed                            │
                    ▼                                          │
   ┌────────────────────────────────────┐                      │
   │            HOSTILE                 │──────────────────────▶┘
   └────────────────────────────────────┘   (only when the target dies
                                             or leaves the world)
   Shortcuts into HOSTILE, bypassing everything:
     • grudge target seen              (from patrol / investigating, instantly)
     • offence with response = shoot   (0.25 s, from any state)
     • shot by a player                (instantly, no LOS needed)
     • provoke broadcast               (instantly, LOS required)
```

### 1.2 State-transition table

| From | Condition | To | Side effects |
|---|---|---|---|
| patrol / investigating | A **grudged** player is visible | **hostile** | Shout *"There he is! Stop him!"*; first shot in 0.75 s |
| patrol / investigating | An offender is visible continuously for **0.75 s**, response = `warn` | **suspicious** | Shout the offence line (voice cue `warn`); route dropped |
| patrol / investigating | An offender is visible continuously for **0.25 s**, response = `shoot` | **hostile** | Shout the offence line (cue `hostile`); first shot in **0.25 s** |
| patrol | Noise heard within radius, guard is **mobile** | **investigating** | Shout *"What was that?"*; walk to noise |
| patrol | Noise heard within radius, guard is **posted** | *(stays patrol)* | Turn to face noise for 4 s |
| investigating | Same, re-triggered by a new noise | **investigating** | Restarts with a new destination and deadline |
| investigating | Arrived and lingered **4 s**, or exceeded the deadline | **patrol** | Rejoin route at nearest waypoint by walking distance |
| investigating | Goal unreachable — stuck for **2.5 s** | **patrol** | Give up on the goal |
| suspicious | Target visible **and** committing no offence, and not `provoked` | **patrol** | Silent stand-down |
| suspicious | Range ≤ **5 m**, or **3 s** in state | **warning** | Shout the offence line again |
| suspicious | Target's offence becomes response = `shoot` | **hostile** | Shout; first shot in **0.25 s** |
| warning | Target visible **and** committing no offence, and not `provoked` | **patrol** | Shout *"Carry on."* |
| warning | **2.0 s** in state | **hostile** | First shot in **0.75 s** |
| warning | Target's offence becomes response = `shoot` | **hostile** | Shout; first shot in **0.25 s** |
| hostile | *(no de-escalation exists)* | — | Complying does nothing |
| any alerted state | Target lost from sight for **4.0 s** | **investigating** (at last known position) | Grudge is retained |
| any alerted state | Target is dead | **patrol** | Shout *"Threat neutralised."* (only if a body is visible) |
| any alerted state | Target vanished from the world | **patrol** | Silent |
| any state | Guard is damaged | **hostile** toward the attacker | Grudge added; **no line of sight needed** |
| any state | `provoke` broadcast reaches him and he can see the victim's or shooter's position | **hostile** | Grudge added; only via the normal hostile entry, so the 0.75 s beat is owed |
| any state | `forget(playerId)` and that player was the target | **patrol** | Grudge on that player deleted |

### 1.3 Per-state detail

---

#### PATROL

**Purpose.** Normal duty. The state a player should see 95% of the time.

**Entry.** Initial state; every stand-down; abandoning an investigation.

**Behavior.**
- **Mobile guard** (multi-point route): walks the loop at **2.0 m/s** using
  pathfinding, advancing when within **0.9 m** of the current waypoint, wrapping
  round the loop forever.
- **Posted sentry** (single-point route): if displaced, walks back to the post;
  otherwise stands still and turns toward `postYaw` at **5 rad/s** — or toward a
  remembered noise while the 4 s alert-look timer runs.
- Every tick: scans for grudged players, then for offenders.
- If no offender is visible, the reaction timer **drains** at 1× real time
  (`max(0, seenFor − dt)`), and after 4 s without sight the current target id is
  cleared.
- **Only in this state** does he pick up dropped weapons (§1.5).
- Pushes open any non-restricted door within **1.3 m**. Will not touch the HQ
  door (except the Secretary; guards need to be alerted).

**Timers.** `seenFor` (offence accumulator), `alertLookTimer` (0–4 s),
`lostSight`.

**Exits.** → suspicious, → hostile, → investigating (see table).

---

#### INVESTIGATING

**Purpose.** "I heard something / he was here a second ago." A curiosity state,
not a threat state.

**Entry.** Hearing a noise while mobile; losing a chased target for 4 s
(via `search`, which clears the target id and the `provoked` flag but **keeps
the grudge**).

**Behavior.**
- Walks to the noise at **3.2 m/s**, aiming for a personal offset spot ~**1.2 m**
  from the exact point so multiple responders don't stack up.
- Arrival is measured against the actual noise point, at **1.5 m**.
- On arrival: stands still and sweeps facing across the **bearing he approached
  on**: `yaw = approachBearing + sin(t × 1.1) × 1.2 rad`.
- Still scans for grudges and offences every tick, exactly as in patrol.
- **Does not** pick up dropped weapons (no detouring mid-search).
- May push open restricted doors (he is not in `patrol`).

**Timers.**
- `investigateTimer` — seconds on station; resets to 0 whenever he is more than
  1.5 m from the spot.
- `investigateDeadline` = `max(11 s, pathLength / 3.2 + 4 s + 4 s)`, measured
  against time-in-state.

**Exits.** → patrol when `investigateTimer ≥ 4 s` **or** time-in-state ≥ deadline
**or** stuck for 2.5 s. → suspicious / hostile on sighting.

---

#### SUSPICIOUS

**Purpose.** "I have seen you do something you may not do, and I am coming over."

**Entry.** 0.75 s of continuous, visible, `warn`-class offence.

**Behavior.** Faces the target. Closes at **3.2 m/s** toward the target if
visible, or toward the last known position if not. Stops closing once inside
**5 m** *and* with a clear straight line (if the line is blocked he keeps
pathing — otherwise he would stop "5 m away" through a wall and grind).
Rifle is **not** raised yet (`aiming` is false).

**Timers.** `modeTimer` — drives the 3 s fallback promotion.

**Exits.**
- → warning: `range ≤ 5 m` **or** `modeTimer > 3 s`.
- → patrol: target visible and clean, and `provoked` is false.
- → hostile: offence upgrades to `shoot`.
- → investigating: 4 s without sight.

**UNCERTAIN:** the 3 s fallback promotion exists so a guard who cannot physically
reach the target still escalates. Whether the intended reading is "he loses
patience" or it is purely a safety valve is not stated anywhere.

---

#### WARNING

**Purpose.** The grace period. The one chance to comply.

**Entry.** From suspicious only.

**Behavior.** Rifle **raised** (`aiming` true — this is the sole visible tell
that a guard has escalated). Shouts the offence line on entry; nearby humans see
it as chat and hear a voice cue. Closes at **1.6 m/s** (half approach speed).

**Timers.** `modeTimer` vs **2.0 s**.

**Exits.**
- → patrol: target visible and clean, and `provoked` is false. Shouts
  *"Carry on."*
- → hostile: `modeTimer ≥ 2.0 s`.
- → hostile immediately if the offence upgrades to `shoot`.
- → investigating: 4 s without sight.

**Critical:** compliance must be **seen**. Stepping behind a wall keeps the
2 s clock running and you emerge to a hostile guard.

---

#### HOSTILE

**Purpose.** Lethal force. Terminal state — nothing the target does ends it.

**Entry.** Warning expiry; shoot-on-sight offence; seeing a grudged player;
being shot; a provoke broadcast.

**On entry (always):**
1. `nextShotAt = now + firstShotDelay` (0.75 s normally, 0.25 s in a
   shoot-on-sight zone). This beat is the player's chance to run.
2. `provoked = true` — permanently disables de-escalation for this encounter.
3. The target's id is added to this guard's **grudge set**.
4. If the guard is standing inside the shoot-on-sight zone, the **General is
   alarmed** — his own detail opening fire in his office is all the warning he
   gets, and he does not need to see anything.
5. Any dropped-item retrieval goal is abandoned; the cached path is dropped.

**Behavior.** Faces and closes at **3.2 m/s**, stopping at 5 m standoff. Fires
one rifle round every **1.1 s** provided: he is armed (his rifle has not been
confiscated), the target is **currently visible**, and range ≤ 90 m. Each shot
is a hitscan from eye height at the target's chest, with a random spread cone of
~2.4°. Guard shots resolve against **players only** — a guard cannot hit another
NPC.

**Exits.**
- → patrol when the target is **dead** (shout *"Threat neutralised."* if he can
  see the body) or has left the world.
- → investigating after **4.0 s** without sight — but the grudge outlives it, so
  the next sighting is instantly hostile again.
- → patrol via `forget()` (player respawn / round reset only).

### 1.4 Guard sub-behaviors that are not states

| Sub-behavior | Active in | Duration / threshold |
|---|---|---|
| **Alert look** (posted sentry turning toward a noise) | patrol only | 4 s |
| **Item retrieval** | patrol only | 12 s deadline, 8 m sight radius |
| **Stuck recovery** | any moving state | repath at 0.6 s, abandon goal at 2.5 s |
| **Door opening** | any | 1.3 m radius; restricted door needs non-patrol mode or the Secretary role |

### 1.5 Complete timeline of a standard challenge

Point-blank, a Doctor draws a pistol in front of a patrolling guard:

| t | Event |
|---|---|
| 0.00 s | Pistol becomes visible. `seenFor` starts. |
| 0.75 s | → **suspicious**. Shout *"Put the weapon away!"* |
| 0.75 s | Already inside 5 m → immediately → **warning** on the next tick. Rifle raised, shout again. |
| 2.75 s | Warning expires → **hostile**. `nextShotAt = 3.50 s`. |
| 3.50 s | **First shot.** |
| 4.60 s | Second shot. Every 1.1 s thereafter. |

At 20 m the same sequence inserts a walk: ~4.7 s of closing at 3.2 m/s between
suspicious and warning, so the first bullet lands around **8 s** after the pistol
appeared.

---

## Part 2 — The General

Reuses the guard's mode names for unrelated meanings.

| Name | Means |
|---|---|
| `patrol` | Standing at his desk |
| `investigating` | Moving between cover, hiding |
| `hostile` | Bolting for the door |

He never has `suspicious` or `warning`, and he never attacks in any state.

### 2.1 Transition table

| From | Condition | To |
|---|---|---|
| desk | Visible armed person **inside the office zone** for **0.75 s** | cover |
| desk | Gunshot inside the office zone, **or** within **14 m** of him | cover |
| desk | He is damaged | cover (threat = attacker) |
| desk | One of his own guards goes hostile while inside the office | cover |
| cover | No hidden cover spot exists in the room | bolt |
| cover | Threat's last known position is **inside the office** | bolt |
| cover | He has taken **2 hits** | bolt |
| cover / bolt | **8 s** with no sign of the threat | desk |

Note: an alarm arriving while he is **already** in cover or bolting only
**refreshes what he knows** (threat id, last known position, resets the
lost-sight timer). It does not restart the decision.

### 2.2 State detail

**DESK (`patrol`).** Walks back to (0, −21.2), turns to face the door (yaw = π),
and stands. Scans for the nearest *armed* person who is *inside the
shoot-on-sight zone* and in line of sight. An armed man out in the corridor is
explicitly not his concern — the guards handle that.

**COVER (`investigating`).** Every **0.7 s** re-picks the best cover spot: any
candidate prop position at least **1.6 m** tall, standing **0.4 m** off it, from
which the *threat cannot see his chest* (same eye/chest raycast the guards use),
scored by `walkingDistance − 0.35 × distanceFromThreat` and minimised. Runs
there at **3.6 m/s**. On arrival (within 0.35 m) he stops and **turns to face the
threat's direction** — facing costs him nothing geometrically but points his
vision cone at the door so he tracks someone leaning out.
If he never saw who it was, the assumed threat direction is the **HQ door**,
because there is no other way in.

**BOLT (`hostile`).** Runs to the HQ door at **3.6 m/s** — toward his guards, not
into an empty corridor — and stops when he arrives, facing the threat direction.

### 2.3 Threshold summary

| Value | Setting |
|---|---|
| Confirmation delay before hiding | 0.75 s |
| Cover re-pick interval | 0.7 s |
| Flee speed | 3.6 m/s (slower than a sprinting player, on purpose) |
| Minimum cover height | 1.6 m |
| Cover standoff | 0.4 m |
| Hits before bolting | 2 |
| Calm-down | 8 s |
| Gunshot alarm radius | 14 m |

---

## Part 3 — Staff

Not a threat machine. A two-phase loop over an ordered list of stops.

| Phase | Behavior | Exit |
|---|---|---|
| **Travelling** | Path to the current stop at **2.0 m/s** | Within **0.9 m** of the stop |
| **Dwelling** | Stand still, turn to the stop's facing (or keep the arrival facing) | `dwell` reaches 0 |

On arrival: `dwell = max(1, stop.seconds ± stop.jitter)`, the stop index advances
(wrapping), and the cached path is dropped. Staff **start dwelling at stop 0** so
the first thing a player sees them do is their job.

Staff never enter any other state. They cannot become suspicious or hostile; the
unattended-simulation test asserts this explicitly. They never look at anybody.

Routines:

| Role | Stops (x, z) | Dwell |
|---|---|---|
| Doctor | (7.5, 5.5) → (12.0, 4.5) → (4.6, 23.0) → (8.0, 9.0) | 25±5, 8±2, 12±4, 15±4 s |
| Secretary | (−8.0, 5.0) → (0.0, −17.5) | 18±4, 20±5 s |
| Telegram Operator | (−9.6, 4) → (−9.6, 7) → (−9.6, 10) | 150±30 s each |

---

## Part 4 — Patients

No state, no timers, no movement. Two NPCs lying on ward beds at (5.5, 4) and
(5.5, 7), 50 HP, rendered in a lying pose. They are skipped entirely by the
simulation loop. They can be shot, or die of neglect via a separate medical
system (which kills them **without** provoking any guard — nobody was attacked).

---

## Part 5 — The stunned condition (all NPCs)

Orthogonal to every machine above. While `now < stunnedUntil`, an NPC's entire
brain is skipped: no perception, no movement, no timers advance, no state
changes. He is a statue that can still be shot.

| Source | Duration |
|---|---|
| Melee hit that does not kill | 0.6 s |
| Being searched by a Security Officer | 15 s |

**Consequence to be aware of:** because *mode timers* are frozen too, a guard
stunned mid-`warning` resumes with the same grace remaining rather than losing
it. See `NPC_IMPLEMENTATION_NOTES.md` §4.3 — this is arguably correct but is
not stated as a decision anywhere.

---

## Part 6 — Global reset

`reset(seats)` rebuilds the entire NPC population: guards are dealt to posts (HQ
posts first, then field posts in **reverse** order), staff to their routines, one
General, two patients. `forget(playerId)` removes that player's id from every
grudge set and stands down any NPC currently targeting them. It is called on
player respawn and at round start only.
