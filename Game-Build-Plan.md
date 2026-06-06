# MOSH — Game Build Plan (Step 1: playable scene in the map)

*Created 2026-06-06. The hands-on build plan for the first playable game scene, on top
of the research in `Tech-Stack-Research.md` + `Game-Logic-Deep-Dive.md`. Tracks what's
installed, what exists, what we're building now, and how it works.*

---

## Where we are

**Installed (this session):**
- `three-mesh-bvh` — fast bullet/hitscan raycasts against the static arena.
- `@react-three/rapier` v2 — physics (capsule + arena collision) for the proper controller step.
- (Already had: `@react-three/fiber` v9, `@react-three/drei` v10, `three` r0.183,
  `@mediapipe/tasks-vision`, `zustand`, React 19.)

**Already in the project:**
- `src/App.tsx` — the **studio** (model viewer) at port 5155.
- `src/Models.tsx` — `Arena()` (the `arena_opt.glb` map, currently unrendered),
  `FitModel` (fits a character, puts the gun in its hand with the tuned hold + finger
  curl, plays a clip via `ClipPlayer`), `Character`.
- `src/Gun.tsx` — 3 procedural guns (normal / golden / blaster) with the tuned hand-hold.
- `src/Scatter.tsx` — trees/rocks (unrendered).
- `public/animations/*.glb` — the Mixamo clip set: `aiming_idle`, `walking`,
  `strafe_left`, `strafe_right`, `firing`, `reloading`, `crouch_idle`, `grabbing`,
  `punch`, `dying`.
- `public/models/*.glb` — `arena_opt`, `character_a/b`, `clay`.

**Not built yet:** any actual game scene. That's this step.

---

## Step 1 goal (what we're building now)

A **playable third-person sandbox in the arena map**, testable at 5155, that proves the
core systems end-to-end:

- The **arena** (`arena_opt.glb`) rendered as the world.
- A **character** standing in it, holding a gun.
- **WASD movement** (camera-relative) — walk + strafe.
- The **animation system** driven by movement state: idle ↔ walk ↔ strafe, plus
  fire / reload / crouch — so all the clips are exercised in-game.
- **Shooting**: click to fire → a **visible bullet/tracer** flies forward from the
  muzzle, raycasts the arena, and sparks on impact ("little bullets, see how it works").
- A **Studio ↔ Game toggle** so the existing model studio stays, and 5155 can switch
  into the game.

This is the keyboard-driven foundation. Body-control (MediaPipe) and multiplayer
(SpacetimeDB) plug into the same seams later without rewriting game logic.

---

## Architecture of the build

### Files
| File | Role |
|---|---|
| `src/game/GameView.tsx` | Full game screen: its own `<Canvas>`, arena, lights, camera (OrbitControls following the player), HUD/crosshair, exit button. Hosts the Player + Bullets. |
| `src/game/Player.tsx` | The controllable character. Reads input → camera-relative movement → moves the player group; computes animation state; fires bullets. Wraps `FitModel` (reused for fit + gun-in-hand + clip playback). |
| `src/game/Bullets.tsx` | Bullet/tracer system. `spawnBullet(origin, dir)` + an instanced renderer that advances each bullet, raycasts the arena (BVH), sparks + removes on hit, expires by lifetime. Kept out of React state for perf. |
| `src/game/useKeys.ts` | Tiny keyboard hook → a ref of pressed keys (the input source). |
| `src/App.tsx` | Add a `mode` toggle (`studio` / `game`) + a "🎮 Play" button. |

### Why reuse `FitModel` for the character
`FitModel` already: clones the rig correctly, stands it up + scales to height, drops feet
to the origin, portals the gun into the right-hand bone with the **tuned animation-hold
preset**, curls the fingers, and plays a clip. So the game character = `FitModel` with its
`animation` prop driven by movement state. The current `ClipPlayer` hard-cuts between clips
(no crossfade) — **acceptable for this first test**; the crossfading blender is the next
refinement.

### How movement works
- `useKeys` tracks WASD (+ R reload, C crouch).
- Each frame: build a move vector from keys, rotate it by the **camera yaw** (flatten
  pitch) so it's camera-relative, normalize, advance the player group on XZ at walk speed.
- The character faces the camera-forward direction; A/D produce strafe, W/S produce walk.
- Camera: drei `OrbitControls` with its target lerped to the player each frame (orbit to
  look around / aim; wheel to zoom — same feel as the studio).

### How animation works (this step)
Movement state → clip URL, passed to `FitModel.animation`:
| State | Clip |
|---|---|
| not moving | `aiming_idle.glb` |
| W / S | `walking.glb` |
| A | `strafe_left.glb` |
| D | `strafe_right.glb` |
| click (≈0.35s) | `firing.glb` |
| R | `reloading.glb` (~0.7s) |
| C | `crouch_idle.glb` |
State only changes the prop when it actually changes (no per-frame churn). Hard-cut now;
crossfade blender later.

### How bullets work
- On fire: `spawnBullet(muzzlePos, camForwardDir)` — bullet = `{ pos, vel, life }`,
  velocity ≈ 50 m/s along aim, life ≈ 2s.
- Rendered as small emissive spheres (+ a stretched tracer) via an instanced mesh, updated
  in `useFrame` (mutable, not React state).
- Each frame: advance `pos += vel·dt`; raycast from previous→new position against the
  arena (BVH `firstHitOnly`); on hit → spark + remove; else remove at life end.
- This is the **visible "bullet"**; the hitscan/damage model (instant raycast, recoil,
  ammo, server rewind) from `Game-Logic-Deep-Dive.md §2` layers on next.

---

## The game rules it's heading toward (recap)

Team elimination, one semi-auto pistol. Round: spawn full HP (100) + full mag (12) →
fight → **die = out for the round** (free-fly spectate) → **wipe the enemy team to win the
round** (or timer tiebreak: more alive → more HP → draw) → +1 round → respawn next round.
**Match = first team to N round-wins** (best-of). Friendly fire off. (Open feel decisions:
1-tap vs 2-tap headshot; best-of count.) Full detail in `Game-Logic-Deep-Dive.md §3`.

---

## The seams everything plugs into (don't break these)

1. **`Controls` contract** — one input object `{ yawDelta, pitchDelta, moveForward/Back,
   strafeLeft/Right, crouch, firePressed, reloadPressed }`. Keyboard fills it now;
   MediaPipe fills it later; network-replicated inputs after that. **Game logic never
   changes** when input source changes.
2. **Animation blender** — movement/fire just set state/params; the (upcoming) blender
   turns them into crossfaded clips. The keystone every later layer feeds.

---

## Build order from here

1. **(this) Single-player scene** — arena + character + WASD + animation states + visible
   bullets + Studio/Game toggle. Test at 5155.
2. Rapier capsule + arena collision (walk on real geometry, no clipping); hitscan + recoil
   + ammo/reload + muzzle/decal FX; FPP camera option.
3. MediaPipe body control via the `Controls` contract + 3s calibration.
4. SpacetimeDB authoritative server (tables/reducers, predict→replay, interpolation).
5. Spectator stream + AI caster.

---

## Doc map
- `Valor-plan.md` — the game design / hackathon plan.
- `Tech-Stack-Research.md` — what to reuse vs build (repos, packages, assets).
- `Game-Logic-Deep-Dive.md` — the real implementation logic + numbers (movement, gun,
  match flow, SpacetimeDB, MediaPipe).
- `Mixamo-Animation-List.md` — the clip set + pipeline.
- `Game-Build-Plan.md` — **this file** — the hands-on Step-1 build.
