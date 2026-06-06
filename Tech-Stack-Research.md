# MOSH — Tech Stack Research & Integration Plan

*Research date: 2026-06-06. Companion to `Valor-plan.md` (the game design) and
`Mixamo-Animation-List.md` (the clip set).*

This documents what we researched to build the actual game, what reusable code /
repos / assets we found, what to integrate first, and the build order. Goal of
the research: **for a body-controlled multiplayer FPS in the browser, what can we
reuse vs. what must we build ourselves** — so we don't reinvent solved problems.

Our stack is the *current* pmndrs target, which is why almost everything lines up
with no version fighting:

| | Version |
|---|---|
| React | 19 |
| @react-three/fiber | v9 |
| @react-three/drei | v10.7 |
| three | r0.183 |
| @mediapipe/tasks-vision | ^0.10.32 (already installed) |
| zustand | v5 (already installed) |
| TypeScript / Vite | 5.7 / 6 |

All resources below are **MIT / ISC / Apache-2.0 / CC0** — safe to use commercially.

---

## 0. What exists today (starting point)

- Only the **studio** (`src/App.tsx`) runs — a model viewer (port 5155). `main.tsx`
  renders it directly.
- **No game scene exists yet.** `Arena()` (the `arena_opt.glb` map) and `Scatter`
  (trees/rocks) are written in `src/Models.tsx` / `src/Scatter.tsx` but **not
  rendered anywhere**.
- Animation system (`ClipPlayer` in `src/Models.tsx`) plays **one clip at a time**,
  remounting a fresh `AnimationMixer` per clip → hard cuts, no blending.
- Guns (`src/Gun.tsx`) are procedural (extruded profiles), 3 variants, with a
  tuned hand-hold. Characters + animation clips are GLB (in `public/`).

So "add characters to the game and play" = **build the first real game scene**,
which doesn't exist yet.

---

## 1. The research method

Four parallel research threads, each scouring the web, GitHub (stars / license /
maintenance), Reddit (r/threejs, r/gamedev), pmndrs docs & discussions, dev blogs,
and YouTube, then verifying repos/URLs actually resolve:

1. R3F game scene + character/FPS controllers + animation blending
2. SpacetimeDB + multiplayer netcode
3. MediaPipe webcam → game input
4. FPS game logic + free assets

(LinkedIn is login-walled and not scrapeable headlessly, so it was skipped in
favor of GitHub / Reddit / official docs / blogs.)

---

## 2. The standout finds

- **`vibe-coding-starter-pack-3d-multiplayer`** — React 19 + R3F 9 + drei 10 +
  three 0.175 + **SpacetimeDB 2.0** + Rust server. Almost our exact stack. Already
  implements server-authoritative movement **with client-side prediction**, player
  position + animation sync, ~20Hz input reducer, and a 100-bot load test. This is
  the multiplayer skeleton to crib, not build from scratch.
- **`ecctrl`** (pmndrs) — floating-capsule character controller whose peer-deps are
  an *exact* match for us (React ≥19.1, fiber ≥9, drei ≥9, three ≥0.177). Movement
  + collision + first-person support, drop-in.
- **MediaPipe `GestureRecognizer`** — ships `Open_Palm` / `Closed_Fist` as built-in
  labels. That's our fire (open→fist) and reload (fist-held) **with no classifier
  to train** — the hardest part of body-control is essentially free.

---

## 3. Reuse vs. build — by layer

| Layer | Pull in (reuse) | Build ourselves |
|---|---|---|
| Movement / collision | `ecctrl` + `@react-three/rapier` v2 | thin glue to our rig |
| Camera / input | drei `KeyboardControls` + `PointerLockControls` (installed) | yaw/pitch + recoil offset |
| **Animation** | drei `useAnimations` (crossfade API) | ⚠️ **the locomotion blender** — no off-the-shelf exists |
| Multiplayer | `vibe-coding` starter + `spacetimedb` npm v2.4.1 + Blackholio (Rust patterns) | our tables/reducers (fire/damage/score) |
| Netcode | Gambetta prediction/reconciliation/lag-comp articles | hitscan rewind in `fire()` |
| Body control | MediaPipe `GestureRecognizer` + `PoseLandmarker` + One-Euro filter | ~150 lines: torso-relative mapping + hysteresis + 3s calibration |
| Shooting | `three-mesh-bvh` (static), plain `Raycaster` vs player capsules | tracer/decal/muzzle effects |
| Feel / FX | `@react-three/postprocessing` Bloom, drei `Sparkles`/`Trail`/`CameraShake` | recoil curve, crosshair (DOM) |
| State | `zustand` (have it); `koota` ECS *later* | match state enum / timers |
| Audio | CC0 packs (Kenney, Still North Media, Signature Sounds) | WebAudio one-shot pool |
| AI caster | ElevenLabs Flash TTS (canned barks + streamed LLM) | read-only STDB subscriber service |

---

## 4. The loot list (concrete resources)

### Repos to clone / crib from
| Repo | License | What we get |
|---|---|---|
| [vibe-coding-starter-pack-3d-multiplayer](https://github.com/majidmanzarpour/vibe-coding-starter-pack-3d-multiplayer) | MIT | React19/R3F9/STDB2.0/Rust; server-authoritative movement + client prediction + anim sync + bot load test. **Our multiplayer skeleton.** Targets STDB 2.0.1 → bump to 2.4.x. |
| [clockworklabs/Blackholio](https://github.com/clockworklabs/Blackholio) | — | Official STDB game; Rust module patterns (tables, scheduled-reducer tick loop, scoring). Clients are Unity/Unreal (don't reuse), module is gold. |
| [mohsenheydari/three-fps](https://github.com/mohsenheydari/three-fps) | MIT | Full FPS architecture reference (controller, shooting, ECS, AI). Vanilla three — study, don't import. |
| [benjidotsh/react-three-fiber-example-fps](https://github.com/benjidotsh/react-three-fiber-example-fps) | MIT | Minimal R3F FPS starter in *our* stack — pointer-lock + movement wiring. |
| [icurtis1/fps-sample-project](https://github.com/icurtis1/fps-sample-project) | MIT | FPS template (walk/run, FOV kick, projectiles). Pins React 18 — read, don't `npm i`. |

### NPM packages to install
| Package | License | Role | Install |
|---|---|---|---|
| [ecctrl](https://github.com/pmndrs/ecctrl) | MIT | Floating-capsule controller, exact peer-dep match, FPP supported | `npm i ecctrl` |
| [@react-three/rapier](https://github.com/pmndrs/react-three-rapier) v2 | MIT | Physics (capsule + arena collision) | `npm i @react-three/rapier` |
| [spacetimedb](https://www.npmjs.com/package/spacetimedb) v2.4.1 | ISC | **Current** STDB client SDK (NOT deprecated `@clockworklabs/spacetimedb-sdk`) | `npm i spacetimedb` |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | MIT | Fast hitscan raycasts vs static arena | `npm i three-mesh-bvh` |
| [@react-three/postprocessing](https://github.com/pmndrs/react-postprocessing) | MIT | Bloom → blaster/muzzle glow | `npm i @react-three/postprocessing` |
| [1eurofilter](https://www.npmjs.com/package/1eurofilter) | MIT | Smooth MediaPipe aim/lean | `npm i 1eurofilter` |
| [koota](https://github.com/pmndrs/koota) (later) | ISC | ECS if entities grow | `npm i koota` |
| [xstate](https://xstate.js.org) (maybe) | MIT | State machine if round graph gets hairy | `npm i xstate` |

### Alternatives considered (not chosen)
- Movement: `BVHEcctrl` + `three-mesh-bvh` (no physics engine) — leaner, deterministic; smaller community. Viable lane if we want to drop Rapier.
- Physics: `@react-three/cannon` (slow, lagging fiber v9), Jolt bindings (immature) — **skip**.
- Multiplayer transport: Colyseus (write your own authoritative server), geckos.io (UDP/WebRTC, lowest latency, build everything else), Hathora (hosting only), PlayroomKit (client-authoritative → fails anti-cheat), Socket.io (lowest-level). **SpacetimeDB wins** because it *is* server + DB + sync + persistence with reducers running in-transaction (anti-cheat boundary) and auto delta subscriptions for players + spectators.
- ECS: `miniplex` — great DX but stale (last release 2023); `koota` is its spiritual successor. Use koota if any.

### Reference reading (patterns, not code)
- Gabriel Gambetta, **Fast-Paced Multiplayer**: [architecture](https://gabrielgambetta.com/client-server-game-architecture.html) · [prediction & reconciliation](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html) · [entity interpolation](https://www.gabrielgambetta.com/entity-interpolation.html) · [lag compensation](https://www.gabrielgambetta.com/lag-compensation.html). The netcode bible — predict locally, reconcile to server, interpolate *other* players ~100ms in the past, rewind hitboxes server-side for fair hitscan.
- [Wawa Sensei](https://wawasensei.dev/) — R3F animation + multiplayer tutorials (wiring patterns; uses Playroom/Socket.io but the R3F glue transfers).
- SpacetimeDB [docs](https://spacetimedb.com/docs/) · [TS client](https://spacetimedb.com/docs/clients/typescript/) · [1.0→2.0 migration](https://spacetimedb.com/docs/upgrade/).

### Free CC0 assets (sounds — 3D weapon models stay procedural)
- [Kenney](https://kenney.nl/assets) — UI + impact SFX (hit markers, confirms).
- [Still North Media firearms (CC0)](https://github.com/PanderMusubi/sound-effects-library-weapons) — gunshot / reload / dry-fire, multi-mic.
- [Signature Sounds Bullet/Gun CC0](https://signaturesounds.org/store/p/bulletgun-sfx-cc0) — racking, dry-fire, shells, mag inserts.
- [Freesound](https://freesound.org) (filter CC0) · [Pixabay SFX](https://pixabay.com/sound-effects/) (royalty-free fallback).

### Already-have, just use better
- **@mediapipe/tasks-vision** — `GestureRecognizer` (`Open_Palm`/`Closed_Fist` = fire + reload, no training) + `PoseLandmarker` lite (world-landmarks shoulders 11/12, hips 23/24 = lean/strafe/crouch). Self-host wasm + `.task` files in `public/`.
- **drei** — `KeyboardControls`, `PointerLockControls`, `Sparkles`, `Trail`, `CameraShake`, `PositionalAudio`.
- **zustand** — game/match/player state store.

---

## 5. The one thing nobody hands us: the animation blender

There is **no mature off-the-shelf R3F locomotion blend-tree**. This is the
keystone — every input layer (keyboard, then MediaPipe, then network) feeds into
animation. Plan:

- Replace `ClipPlayer`'s per-clip mixer remount (hard cut) with **one
  `AnimationMixer` holding all clips** via drei `useAnimations`.
- **Weight-blend** idle / walk-fwd / walk-back / strafe-L / strafe-R by the movement
  vector; crossfade ~0.15s on state change (`crossFadeTo` / `setEffectiveWeight`).
- Run **fire / reload as an additive upper-body layer** so the character can shoot
  while moving.
- Our existing track-normalization (`mixamorig:` colon strip) + position-track
  stripping + missing-bone filtering logic ports straight in — we're ~80% there.

---

## 6. Key risks

- **SpacetimeDB version churn.** 1.0 → 2.4 in months, with breaking changes (removed
  reducer callbacks, light mode, CallReducerFlags; confirmed reads default on). The
  **deprecated** package is `@clockworklabs/spacetimedb-sdk`; the **current** one is
  `spacetimedb` (v2.4.1). Pin CLI + Rust crate + npm together; regenerate bindings on
  every bump; read the migration guide before adopting older tutorials/repos.
- **MediaPipe blocks the thread.** `detectForVideo` is synchronous — run pose every
  frame but throttle the gesture pass to ~10Hz, GPU delegate on, `numPoses:1`; move to
  a Web Worker if the R3F scene stutters. Pin wasm to the installed version (self-host).
- **Reference repos with old pins** (`fps-sample-project` = React 18 / rapier v1) —
  read for patterns, don't `npm i`.

---

## 7. Build order (recommended)

1. **Single-player game scene** — `ecctrl` + rapier, character walks the arena,
   **build the animation blender**, third-person camera. No server/webcam yet —
   validates rig + anim + arena. *(This finally renders `Arena()` + `Scatter`.)*
2. **First-person camera + gun** — FPP cam, gun in view, hitscan (`three-mesh-bvh` +
   Raycaster), recoil + muzzle/tracer FX wired to the blender.
3. **MediaPipe body control** — swap keyboard → GestureRecognizer + PoseLandmarker +
   One-Euro + 3s calibration; torso-relative lean/strafe/crouch, open→fist fire,
   fist-held reload.
4. **SpacetimeDB** — adapt the vibe-coding starter; our tables (`players`, `match`,
   `shots`, `spectators`) + reducers (`fire`/`damage`/`score`, scheduled `tick`);
   client prediction + interpolation; server-side hitscan rewind.
5. **Spectator stream + AI caster** — read-only STDB subscription for the big screen +
   phones; canned TTS barks first, streamed LLM color commentary second.

**Integrate-first shortlist (Step 1):** `ecctrl`, `@react-three/rapier`, drei
controls (have), + the custom animation blender.

---

## 8. Source index

R3F / controllers / anim: ecctrl, BVHEcctrl, react-three-rapier, fps-sample-project,
character-controller-sample-project (icurtis1), Codrops physics-controller, Wawa
Sensei anim+multiplayer, codeworkshop.dev, koota, miniplex, douges.dev ECS,
webgamedev.com. · SpacetimeDB: SpacetimeDB repo + docs + TS client + migration guide,
vibe-coding starter, Blackholio, Gambetta series, Colyseus/PlayroomKit/Hathora,
ElevenLabs Flash + eleven-labs-tts-stream + RealtimeTTS. · MediaPipe: Tasks-Vision web
guides (Pose/Hand/Gesture), tasks-vision npm, BaseOptions/Delegate, Google ML-on-web
dos/don'ts, ankdev.me worker tutorial + ankitskvmdam/mediapipe-example,
bandinopla/three-mediapipe-rig, collidingScopes/threejs-handtracking-101, 1eurofilter
/ OneEuroFilter-ts, smoothing-filters article. · FPS logic/assets: three-mesh-bvh,
three.js Raycaster, three-fps, r3fps, react-three-fiber-example-fps, three-arena,
Moxxi, three-screenshake, XState + multiplayer-xstate, react-postprocessing Bloom,
drei, Kenney / Still North Media / Signature Sounds / Freesound / Pixabay.
