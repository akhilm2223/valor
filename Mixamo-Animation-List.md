# MOSH — Mixamo Animation List

Companion to **Valor-plan.md §4**. The confirmed clip set for the body-controlled
pistol FPS, what's done, and how to add the rest.

> **One gun, on purpose: semi-auto pistol.** Every combat/locomotion clip must be a
> **pistol** clip so the hands wrap the short `Gun.tsx` pistol — *not* a rifle clip
> (two hands forward around a long gun leaves the pistol floating). The first import
> ("Slim Shooter Pack") was **rifle**; those GLBs stay only as pipeline test assets
> and are replaced by the pistol re-pull below.

---

## Pipeline (locked — proven by the studio)

1. **Source:** Mixamo, **one rig (X/Y Bot)** for every clip so skeletons match.
   Download **FBX Binary**, **30 fps**, **"In Place" ON** for anything that would
   otherwise travel (locomotion, and usually fire/reload/idle too).
2. **Convert:** drop the `.fbx` into `public/animations/` and run
   `blender --background --python public/animations/_convert.py` → `.glb`.
   (three's `FBXLoader` can't read Mixamo's FBX 2020 binaries; Blender can.)
3. **Play:** `ClipPlayer` in `src/Models.tsx` retargets by bone name onto the
   character rig — normalizes the `mixamorig:` colon, drops position tracks, and
   filters tracks for bones the reduced rig lacks.
4. **Wire (game):** crossfade clips ~0.15s via one `AnimationMixer`, keyed off the
   SpacetimeDB `players.anim` state. Full-body switching, no upper/lower layering.

### ⚠️ Two pipeline gaps to close before crouch/death look right
- **Hip-drop is stripped.** `ClipPlayer` currently drops *all* position tracks for
  clean in-place locomotion. Crouch and death legitimately need the hips to lower /
  fall — with position stripped the body stays at standing height while only the
  limbs move (stiff). Add a per-clip option to **keep a scaled hips-Y track** for
  crouch transitions + deaths.
- **Reduced hands.** The game rigs have only Thumb + Index finger bones, so finger
  detail in clips is ignored (expected). Grip is helped by the `gripCurl` procedural
  curl in `FitModel`.

---

## The set

Status: ✅ done · 🔁 have rifle placeholder, re-pull as pistol · ⬜ not sourced yet

### Gesture-driven (each maps to a locked control in §2)

| Clip | Trigger | Mixamo search | In&nbsp;Place | Loop | Notes | Status |
|---|---|---|---|---|---|---|
| Pistol Idle (aim) | aim hand open, center | "Pistol Idle" | ON | loop | the default combat stance | 🔁 |
| Shooting Handgun (fire) | off-hand squeeze | "Pistol Shoot" / "Shooting" | ON | one-shot | trim to the shot (~0.3s); fires once per squeeze | 🔁 |
| Reload | aim-hand fist 0.5s | "Reloading" (pistol) | ON | one-shot | **trim to ~0.7s — the clip IS the fire-lockout timer** | 🔁 |
| Pistol Walk Fwd | lean fwd | "Pistol Walk" | ON | loop | binary fwd (fixed speed) | 🔁 |
| Pistol Walk Back | lean back | "Walk Backward" (pistol) | ON | loop | **missing** — only had fwd | ⬜ |
| Pistol Strafe L | lean left | "Left Strafe" (pistol) | ON | loop | | 🔁 |
| Pistol Strafe R | lean right | "Right Strafe" (pistol) | ON | loop | | 🔁 |
| Standing → Crouch | shoulder dip −15% | "Crouching" / "Stand To Crouch" | ON* | one-shot | *needs hips-Y kept (see gap above) | ⬜ |
| Pistol Kneeling Idle | held crouch | "Pistol Kneeling Idle" | ON* | loop | crouch-aim hold — have "Idle Crouching Aiming" (`crouch_idle`), holds low via joint rotation so hips-Y not needed here | ✅ |
| Crouch → Stand | dip exit −8% | "Crouch To Stand" | ON* | one-shot | hysteresis exit | ⬜ |
| Victory | both arms up, round-end | "Victory" / "Cheering" | ON | loop | winner mirrored on big screen | ⬜ |

### Server-driven (no gesture — free polish)

| Clip | Trigger | Mixamo search | In&nbsp;Place | Loop | Notes | Status |
|---|---|---|---|---|---|---|
| Grabbing Pistol | round start | "Pistol Draw" / "Gun Grab" | ON | one-shot | dramatic round-open on both players — have "Picking Up" (`grabbing`) | ✅ |
| Hit Reaction | confirmed hit | "Hit Reaction" / "Flinch" | ON | one-shot | short flinch — sells the netcode | ⬜ |
| Death — front | killed, shot from front | "Death From Front" | hips-Y* | one-shot | falls backward | ⬜ |
| Death — back | killed, shot from behind | "Death From Back" / "Falling Back Death" | hips-Y* | one-shot | falls forward | ⬜ |

*\*Deaths/crouch need the kept hips-Y track so the body actually drops.*

### Skipped on purpose (§4)
Jump · sprint · `rifle_run` (sprint was cut) · melee / pistol-whip (a sixth combat
gesture = false-positive risk; stretch only). A melee placeholder ("Mutant Punch",
`punch`) is wired in the studio for preview, but stays out of the combat gesture set.

---

## What's in `public/animations/` today

Rifle test clips from the first import (placeholders until the pistol re-pull):
`aiming_idle` · `firing` · `reloading` · `walking` · `strafe_left` · `strafe_right`
· `rifle_run` (cut) · `dying` (generic — replace with front/back deaths).

Newer clips (X/Y Bot, keep): `crouch_idle` (Idle Crouching Aiming) · `grabbing`
(Picking Up) · `punch` (Mutant Punch, melee placeholder).

## To do
- [ ] Re-pull the 7 combat/locomotion clips as **pistol** (X/Y Bot, In Place, FBX).
- [ ] Source the 6 still-missing clips: walk-back, crouch-in, crouch-out, victory,
      hit reaction, death front + back. (Have: crouch-idle, grab.)
- [ ] Add the **keep-hips-Y** option to `ClipPlayer` for crouch + death.
- [ ] Trim Reload to ~0.7s and Fire to ~0.3s.
- [ ] Define the `players.anim` enum (idle/fire/reload/walk_f/walk_b/strafe_l/
      strafe_r/crouch/crouch_idle/victory/grab/hit/death_f/death_b) and the
      crossfade map in the game build.
