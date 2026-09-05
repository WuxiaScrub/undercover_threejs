# Character models

Drop FBX character models here, one folder per character, named after the
character, with the file named the same as its folder:

```
assets/3d/characters/
  guard/guard.fbx
  general/general.fbx
  security/security.fbx
  secretary/secretary.fbx
  doctor/doctor.fbx
  telegram/telegram.fbx
```

Player folder names should match the role ids in `src/shared/roles.ts`
(`security`, `secretary`, `doctor`, `telegram`); `guard` and `general` are the
two NPCs. Any textures a model needs go next to it in the same folder.

Shared animations go in `assets/3d/animations/` (see the README there).

These are loaded by `src/client/player/CharacterAssets.ts` and swapped into
`CharacterMesh` when they arrive. A folder with no model in it is not an error:
that character keeps the blocky placeholder, and the game plays exactly the same.
Drop the file in and it appears; nothing else needs editing.

## What the model has to satisfy

The placeholder is not just art — the server shoots at the same proportions the
client draws, via `BODY_SEGMENTS` in `src/shared/hitbox.ts`. So a replacement
model has to line up with those numbers, or people will be hit by shots that
visibly missed.

The loader fixes what can be fixed by measurement, and cannot fix the rest:

**Handled for you**

- **Height.** Scaled to `GAME_CONFIG.player.height` whatever units it was
  authored in, so centimetres are fine.
- **Feet on the floor.** Re-centred so the lowest point sits at y=0.
- **Facing.** Read off the toe bones and turned to -Z if it was exported the
  other way. Both Mixamo rigs face +Z and are spun automatically.
- **Root motion.** The hips' position track is stripped from every clip.

**Yours to get right**

- **Proportions.** The head has to be where `BODY_SEGMENTS` says a head is:
  legs 0.85, torso 0.63, head 0.28 of a 1.80 m total. Scaling to the right
  overall height cannot fix a body that is short-legged and big-headed, and the
  result is head shots that visibly miss. `npm run test:assets` prints where the
  model's neck lands against the head hitbox.
- **A skeleton.** An unrigged model is rejected outright and the placeholder
  stays — it could hold no pose and play no clip.
- **A right-hand bone** named `...RightHand`, for the weapon to be held at.
- **Bone names matching the clips.** See the animations README.

`npm run test:assets` checks all of this against the real files and prints the
numbers, so a bad export does not have to be found by walking around in-game.

## Weapons

`assets/3d/weapons/{pistol,rifle}/*.fbx` are loaded the same way. A weapon is
scaled to the length `src/shared/weapons.ts` gives it — that file is the single
source of truth, because range and reach are authored against those numbers —
and is held at the grip with the barrel down -Z. A clip whose name contains
`fire` is played on each shot; the pistol ships one, the rifle does not.
