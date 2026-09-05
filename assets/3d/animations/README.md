# Animations

Shared FBX animation clips, flat, one file per clip, named after the action:

```
assets/3d/animations/
  idle.fbx
  walk.fbx
  run.fbx
  jump.fbx
  aim.fbx
  fire.fbx
  punch.fbx
  death.fbx
```

Export these **animation-only** (no mesh) where your tool allows it — the file
is then a few KB instead of a few MB, and one clip drives every character.

## The one thing that matters

Clips play back on a model only if the **bone names and the rest pose match**.
Mixamo clips play on a Mixamo-rigged model; they will not play on a differently
rigged model without retargeting, and retargeting is not something this
prototype should be doing at runtime. Easiest path: rig every character from the
same source (e.g. upload each to Mixamo and download the clips with it), so all
the skeletons are identical and one set of clips covers everyone.

If a character needs a clip nobody else does, put it beside the model in
`assets/3d/characters/<name>/` instead of here.

## What the game asks for

The gait is chosen by **what is in the character's hands**, not by a single
"aiming" flag: empty hands use the bare set, a drawn pistol the `pistol_*` set,
a drawn rifle the `rifle_*` set. Guards and the Security Officer therefore get
the rifle animations for free — a guard is handed a rifle when he spawns, and an
officer gets them the moment he draws his.

| Game state | Unarmed | Pistol | Rifle |
|---|---|---|---|
| standing still | `idle` | `pistol_idle` | `rifle_idle` |
| walking | `walk` | `pistol_walk` | `rifle_walk` |
| sprinting | `run` | `pistol_run` | `rifle_run` |
| backpedalling | `walk_backwards` | `pistol_walk_backward` | `rifle_walk_backwards` |
| strafing | `left_strafe` / `right_strafe` | `pistol_strafe_*` | `rifle_strafe_*` |
| airborne | `jump` | `pistol_jump` | `pistol_jump` — borrowed, no rifle jump exists |

One-shot clips, which take the body over for their duration and then hand it
back to the locomotion blend:

| Trigger | Clip |
|---|---|
| melee swing | one of `melee_punch_1..3`, `melee_kick_1..2`, at random |
| reload | `reload`, time-stretched to the weapon's real reload time |
| firing a rifle | `rifle_fire` |
| firing a pistol | none — the weapon model's own slide clip plays |
| death | `rifle_death` if the rifle set is active, else `death_forward` |

### Deliberately not wired

Five files here are loaded by nothing, and that is a decision rather than an
oversight:

| File | Why not |
|---|---|
| `rifle_turn_left`, `rifle_turn_right` | The blend cross-fades on velocity and has no notion of turning in place. Wiring these needs a state machine the prototype does not have (CLAUDE.md §35). |
| `rifle_aim_to_idle`, `rifle_walk_to_idle` | Transitions between states, and the blend has no states to transition between — it interpolates continuously instead. |
| `rifle_melee_get_hit` | Nothing can fire it. Guards have no "was hit" event on the wire, and on a player a 2.3 s stagger would take his body away mid-firefight, which is worse than no reaction at all. |

If a turning state machine ever lands, the first three are waiting.

A character with no clips at all still moves: it keeps the blocky placeholder's
hand-animated walk cycle. A modelled character with clips uses them and the
placeholder is hidden.

`CharacterAssets` looks for each clip in this folder first and then in
`assets/3d/characters/telegram/`, which is where the current set was exported
into. Move them here and that second lookup can go.

The hips' position track is stripped from every clip on load: position belongs
to the game's physics, and a clip that also moves the character drags it off its
own collision cylinder.

**The death clips are the exception.** A death animation lowers the body with
the root, so stripping the whole track leaves the corpse folded up at standing
hip height, floating. For `death_forward` and `rifle_death` the hips' X and Z
are held at their opening value — that is the part that fights the physics —
and Y is left alone, which is the part that actually lays the body down.
`npm run test:assets` asserts those two clips still carry the fall, so a later
edit cannot quietly re-break it.
