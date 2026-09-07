# NPC Design Principles

Why the NPCs behave the way they do. This document is about **intent**, not
implementation — it is the thing to reread when a Godot decision has no obvious
right answer, or when a "smarter" NPC is tempting.

The prototype exists to answer one question: *is the hidden-faction loop fun when
several humans move around a compound, perform duties, hide their allegiance, and
try to protect or kill the General?* Every NPC decision below is downstream of
that question. **The NPCs are not the game. They are the conditions the game is
played under.**

---

## 1. Guards are posted rules, not detectives

The single most important principle, and the easiest one to violate by accident.

A guard's entire judgement is two questions: *is that person visibly holding a
weapon they may not hold?* and *is that person somewhere they may not be?* There
is no suspicion score, no accumulation of small oddities, no inference about who
someone might be, no memory of where you were five minutes ago.

**Why.** Deduction is the *players'* job. The moment an NPC can conclude "the
Doctor is behaving suspiciously", it has taken that conclusion away from the
humans — and it will be wrong in ways that feel arbitrary, because it cannot
explain itself. A guard who shoots you for a reason you can state in one sentence
is fair. A guard who shoots you because a hidden number crossed a threshold is a
random event.

**Corollary.** A guard's reaction is *evidence for other players*. When a human
sees a guard challenge someone, they learn a specific, true fact: that person was
visibly armed, or in the office. That is worth arguing about in chat. A fuzzy
suspicion system produces no such fact.

**Do not add in Godot:** suspicion meters, "behaving oddly" detection, guards who
notice you following someone, guards who remember you were in Storage. If you
want players to be suspicious of that, make it *observable by players*.

---

## 2. Routine NPCs exist to define "normal"

The NPC Doctor, Secretary and Telegram Operator have no threat brain, no
perception and no reactions. They walk short, boring, learnable loops. This looks
like an unfinished system. It is not.

**Why.** A hidden-faction game needs a *baseline*. A human Doctor going to
Storage is only suspicious if the compound has an idea of what a Doctor normally
does. If the NPC Doctor never left the medical ward, a human doing so would not
be suspicious — it would be **unprecedented**, and the whole "explain yourself"
mechanic collapses into a binary tell.

So the NPC Doctor's supply run to Storage is not flavour. It is the **alibi
window** that makes a human Doctor's absence from the ward plausible. The
Secretary's paper run from the telegram room to the General's desk is the same
errand the human Secretary's delivery duty demands, walked at the same pace on
the same route — which is what makes a human walking through the HQ door
ambiguous rather than damning. The Telegram Operator sitting at one console for
two and a half minutes establishes that *sitting still for minutes* is normal for
that role.

**The design rule:** every legitimate-looking thing a human player might need to
do should be something an NPC in that role is also seen doing. Cover has to be
demonstrated to exist before it can be used.

**Preserve in Godot:** the routines themselves, the fact that they are boring and
short, and above all the specific *deviations they license* (Doctor leaves the
ward; Secretary enters HQ; Operator is stationary for a long time).

---

## 3. NPCs are camouflage for humans

Humans and NPCs are dealt from the same roster. An NPC Doctor and a human Doctor
have the same model, the same clothes, the same nametag format. Nothing in the
world identifies which is which.

**Why.** A player scanning a corridor should not be able to instantly reduce the
set of people worth thinking about. The population an infiltrator disappears into
has to be *real*. If NPCs were visually distinct — a different shader, a "BOT"
tag, a stiffer walk — the game would silently become "there are four humans, and
one of them is the killer", which is a much smaller game.

**Preserve in Godot:** absolute visual and behavioral parity between NPC and human
characters in the same role. This is a hard requirement, not polish. Where you
cannot achieve parity, prefer making the *humans* look more like the NPCs.

---

## 4. Predictability is the resource; unpredictability is confined to violence

The NPC layer is almost entirely deterministic. Patrol routes are fixed loops.
Thresholds are fixed. Reactions are fixed. The only randomness anywhere is a few
seconds of jitter on how long a clerk stands at a desk, and the spread cone on a
guard's bullet.

**Why.** A stealth-adjacent game is a **planning** game. The player's fun comes
from watching a guard's circuit, understanding it, and deciding when the corridor
is clear. That is only possible if the circuit is knowable. Randomised patrol
routes feel "more alive" for thirty seconds and then make planning impossible;
what remains is not tension, it is luck.

So the randomness is placed exactly where the player has already committed and
cannot plan any further: **whether a specific bullet hits**. That is the one
place a coin flip adds tension instead of removing agency.

The dwell jitter is a separate, smaller trick: it prevents the loops from being a
metronome you can set a stopwatch by, without making them unpredictable in
*shape*. You can know the Doctor will go to Storage; you cannot know to the
second.

**Preserve in Godot:** deterministic routes, jittered dwell times, randomised
shooting. Resist "wander" behaviors and randomised patrols.

---

## 5. Escalation must always give the player a beat to react

Every path to a guard shooting you contains at least one deliberate pause, and
each pause is doing a different job:

- **0.75 s reaction delay** — a guard is not a tripwire. You can draw a weapon,
  realise there is a guard, and put it away.
- **The shout** — the escalation is *announced*, in text, in voice, and to
  bystanders. You are never shot by a guard who gave no sign.
- **2 s warning** — the actual chance to comply, with the rifle up so you can
  see how serious it is.
- **0.75 s before the first shot after going hostile** — this one is subtle and
  important: even at the moment the guard gives up on you, there is still a beat
  in which running works.

**Why.** Guards must be **beatable but respected**. A guard who kills you
instantly makes the compound a minefield and players stop moving. A guard who
never kills you is scenery. The ladder makes the guard a *cost with a warning
attached* — which means players take calculated risks, which is where the game's
tension lives.

**Preserve in Godot:** the ordering (notice → shout → grace → shoot), and the
existence of a runnable beat at every step. The exact durations are tuning.

---

## 6. Compliance must be witnessed

A guard stands down only if he can see you *and* you are currently clean. Ducking
behind a wall while being challenged does not de-escalate; the timer keeps
running and you emerge to a hostile guard.

**Why.** This makes the de-escalation an actual *decision with a cost* — you must
stay in the open, visible, in front of an armed man, and holster. Anything else
would make the ladder trivially defeatable by strafing behind a crate, and the
guard's warning would carry no weight.

It also produces excellent ambiguity for onlookers: a player who breaks contact
and comes back to a shooting guard looks, to a third party, like someone who
refused a lawful order.

**Preserve in Godot.**

---

## 7. Risk should be a place you can point at

The compound's most dangerous rule is spatial, not behavioral. Standing in the
corridor stub outside the General's office gets you *challenged*. Stepping one
metre further north, across the threshold, gets you *executed with a 0.25 s
delay and no warning at all*. And inside that room, even a legitimately armed
Security Officer is shot on sight.

**Why.** A hard spatial line is learnable, teachable, and arguable. Players can
tell each other "don't go past the sentries", they can watch someone else die
there and understand exactly why, and they can plan around it. It converts the
assassination from a damage problem into an **access** problem, which is the
stated goal: *opportunity → risk → suspicion → action*, not *walk in → click →
win*.

The re-judgement of severity **every tick** is what enforces this. A man being
warned in the corridor who walks through the door does not carry his grace period
across the threshold with him — otherwise you could deliberately provoke a
challenge and use it as two free seconds inside the office.

**Preserve in Godot:** the zone-based shoot/warn distinction, its sharpness, and
the continuous re-evaluation.

---

## 8. Noise tells you *where*, never *who*

Gunfire carries 45 m — most of the compound. A landed punch carries 3 m. A missed
swing is silent. A noise never identifies its maker: a guard walks over and judges
whatever is standing there when he arrives.

**Why (three reasons):**

1. It makes violence **loud** — you cannot shoot someone without the compound
   learning that *something happened somewhere*, which is the information that
   drives player conversation.
2. It makes melee a genuine strategic choice rather than a worse gun: melee is
   ineffective and safe, and the trade is the reason to pick it.
3. Arriving guards judge the scene rather than the event, which produces the
   game's best accidents: the innocent player who runs toward a gunshot and is
   the only person standing there when the guard arrives.

**Preserve in Godot:** all three radii, and especially the fact that noise carries
no identity.

---

## 9. Sentries hold; patrols respond

Guards on single-point posts (and anyone posted inside the General's office) will
**turn** toward a noise but never take a step. Guards on circuits abandon their
route and go look.

**Why.** If sentries responded to noise, a gunshot in Storage would be a lever for
emptying the corridor outside the General's office, and the assassination would
reduce to "make a noise somewhere else". The static posts are the part of the
defence that cannot be manipulated.

But sentries who ignored noise *completely* were a different bug: three of them
stood facing the HQ door while a player shot at their backs from the other
direction. Turning is the compromise — a 162° cone swung round is enough to
notice someone behind you, without the post ever being abandoned.

**Preserve in Godot:** the distinction itself. It is the difference between a
defence that can be defeated by cleverness and one that can be defeated by a
distraction.

---

## 10. Memory should be personal and consequential

When a guard is pushed all the way to lethal force, he remembers your face
personally — not as compound-wide intelligence, but as *that guard's* grudge.
Next time he sees you he opens fire with no delay and no second warning, whatever
you happen to be doing.

**Why.** It gives escalation a **lasting cost**. Without it, surviving a guard
encounter costs nothing and the ladder becomes a nuisance to be walked away from.
With it, the decision "do I let this guard see me draw?" becomes a decision about
the whole rest of the round.

It is also *per-guard*, which is the interesting part: you can be hunted in the
east wing and welcome in the west. The compound has no shared intelligence
network, so knowledge is geographic, and that is a thing players can navigate.

**But:** see `NPC_IMPLEMENTATION_NOTES.md` §4.1. In the prototype, grudges never
expire and, with permanent death enabled, are never cleared mid-round — so a
single mistake can lock a player out of half the map for fifteen minutes with no
recovery path. The *principle* is right; the *duration* is the part that should
be reconsidered rather than copied.

---

## 11. Ambiguity is the product; the AI should generate it, not resolve it

The behaviors worth protecting most are the ones that make a situation *arguable*
between two humans. Examples the prototype already produces:

- A guard shouting at someone is a **public accusation whose cause is
  invisible** to anyone who didn't see the weapon. "Why did the guard start
  shooting her?" is exactly the sentence the design is aiming for.
- A guard walking to a gunshot judges **whoever is there**, not who fired. An
  innocent bystander can be the one challenged.
- A grudge means a guard attacks someone who is, at that moment, doing nothing
  wrong. Onlookers see an unprovoked shooting. They are wrong, and their being
  wrong is content.
- NPCs and humans in the same role are indistinguishable, so "is anyone even
  watching that room?" is genuinely unknown.
- A guard's escalation is invisible on his nametag. The **only** tell that he has
  decided to shoot you is that his rifle comes up.

**The rule:** when a Godot design decision could either *create* ambiguity or
*resolve* it, create it. Do not add HUD indicators for guard state, alert meters,
"a guard is suspicious of you" warnings, or NPC dialogue explaining what happened.
The uncertainty is the game.

---

## 12. Avoid the robotic feel by fixing failures, not by adding noise

Almost every "aliveness" improvement in the prototype is a **bug fix**, not added
randomness:

- Guards rejoin their patrol at the **nearest** waypoint, not the one that was
  next when they left — otherwise a guard who chased someone across the compound
  walks all the way back, which reads as a machine following a script.
- Investigators sweep across the **bearing they arrived on** instead of spinning
  from whatever facing they happened to have — a guard who came to look at a
  noise and then faces away from it reads as broken.
- Multiple responders **spread out** by 1.2 m instead of all pathing to the same
  square metre and jamming in the doorway.
- The investigation deadline scales with **walking distance**, so a guard doesn't
  set off toward a distant shot and then turn back for no visible reason.
- Stuck NPCs give up and do the next thing: *a guard who abandons a waypoint
  reads as a man losing interest; a guard pressed into a wall reads as a broken
  game.*

**The principle:** an NPC feels robotic mainly when it does something a person
observably would not do. The cure is to remove those specific moments, not to
sprinkle in idle animations or random pauses. In Godot, spend the effort on
navigation quality and failure recovery before spending any on "personality".

---

## 13. Simplicity is a feature, and complexity is a cost paid in confusion

The prototype's brief is explicit: *do not build realistic AI, LLM detectives, or
advanced reasoning*. Guards are deliberately simple.

Beyond the development-cost argument, there is a design argument: **every unit of
NPC intelligence is a unit of the player's model of the world that they cannot
verify.** Players can reason confidently about a guard who enforces two posted
rules. They cannot reason about a guard with heuristics, and so they stop trying,
and the game becomes about avoiding an unpredictable hazard rather than
manipulating a legible system.

If an NPC behavior cannot be explained to a new player in one sentence, it is
probably wrong for this game.

---

## 14. Summary: the behaviors that are essential to preserve

If time is short, these are the ones that carry the design:

1. **Concealment is an absence.** Guards cannot be told about a hidden weapon.
2. **Two posted rules only.** Visible unauthorised weapon; restricted zone. No
   suspicion score.
3. **Line of sight is real.** Walls and shut doors block detection, and block the
   collective `provoke` broadcast too.
4. **Announce before shooting**, with a runnable beat at every stage.
5. **Compliance must be witnessed.**
6. **The office threshold is a hard, spatial, no-warning line.**
7. **Noise says where, not who.** Gunfire is loud; melee is quiet.
8. **Sentries turn, patrols respond.**
9. **Guards remember faces personally** (with a reconsidered duration).
10. **NPC staff routines define "normal"** and license specific human deviations.
11. **NPCs and humans are indistinguishable** in the same role.
12. **Nothing on the HUD reveals a guard's state** except his raised rifle.
13. **The General hides and runs toward his guards; he never fights.**
