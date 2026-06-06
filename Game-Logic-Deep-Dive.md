# MOSH — Game Logic Deep-Dive (implementation reference)

*Research date: 2026-06-06. Extends `Tech-Stack-Research.md` (the loot list) with the
ACTUAL logic, code patterns, and concrete numbers extracted from reading real shipped
repos: `pmndrs/ecctrl`, Rapier KCC docs, `mohsenheydari/three-fps`, `gkjohnson/
three-mesh-bvh`, `halftheopposite/TOSIOS`, `clockworklabs/Blackholio`,
`majidmanzarpour/vibe-coding-starter-pack-3d-multiplayer`, `astahmer/multiplayer-xstate`,
MediaPipe Tasks-Vision docs, `casiez/OneEuroFilter`, `Jamesun921/cam-run`, and Gabriel
Gambetta's netcode series.*

This is the "base from people who've built this" — ready-to-adapt logic for movement,
shooting, match flow, the SpacetimeDB server, and webcam body-control.

---

## 1. Movement / character controller

**Pick: Rapier kinematic character controller (`world.createCharacterController`)** —
cleanest "drop a capsule in `arena_opt.glb` and walk." It does collide-and-slide,
autostep, snap-to-ground, slope limits internally; deterministic, no jitter (unlike a
dynamic body). ecctrl is great but is a third-person *dynamic* floating capsule (more to
strip for a strafing FPS). three-mesh-bvh works but makes you write the shapecast yourself.

### Per-frame update (the real shape)
```
read input (WASD or vector) → wish dir
make camera-relative: flatten camera forward to XZ (fwd.y=0; normalize), build right = fwd × up
target vel = wishWorld * (crouch ? CROUCH_SPEED : WALK_SPEED)
horizVel.x/z = damp(horizVel, target, hasInput ? ACCEL : DAMP, dt)   // smoothing
gravity: if grounded vy = max(vy,-1) else vy = max(vy + GRAVITY*dt, MAX_FALL)
crouch: curHalf = damp(curHalf, crouch?CROUCH_HALF:STAND_HALF, HEIGHT_LERP, dt); collider.setHalfHeight(curHalf)
desired = {x:horizVel.x*dt, y:vy*dt, z:horizVel.z*dt}
controller.computeColliderMovement(collider, desired); mv = controller.computedMovement()
rb.setNextKinematicTranslation(pos + mv)
// state for anim blender:
forwardSpeed = horizVel·fwd ; lateralSpeed = horizVel·right ; grounded = controller.computedGrounded()
```

### Concrete numbers (real defaults + FPS-tuned picks)
| Param | Pick | Source range |
|---|---|---|
| Capsule radius | 0.3 | ecctrl 0.3, icurtis 0.4, bvh 0.5 |
| Standing half-height | 0.6 (~1.8m total) | — |
| Crouch half-height | 0.25 (~1.1m total) | FPS convention |
| Eye/cam height | ~1.5m stand, ~1.0m crouch | — |
| Walk speed | 4.0 m/s | ecctrl 2.5, three-fps 7, bvh 10, icurtis 9 |
| Run speed | 6–7 m/s | — |
| Crouch speed | 1.5–2.0 m/s | — |
| Accel / damp rate | 10–14 move / 14–18 stop | three-fps accel 87.5 (snappy) |
| Gravity | −20 to −30 m/s² | bvh −30; game-feel > realistic |
| Terminal fall | −40 | ecctrl −20 |
| KCC offset (skin) | 0.01 | rapier docs |
| Autostep | maxH 0.5, minW 0.2, dynamic true | rapier docs |
| Snap-to-ground | 0.5 | rapier docs |
| Max slope climb / min slide | 45° / 30° | rapier docs |

### Movement → animation blend params
`forwardSpeed = horizVel·cameraForward`, `lateralSpeed = horizVel·cameraRight` (signed
local-space → picks back-pedal/strafe clips). Normalize to [-1,1] by WALK_SPEED, **damp the
params** (rate ~10) — raw per-frame velocity is jittery and shimmers the blend. `isMoving =
speed > 0.1`; `crouchAmount` 0..1 from capsule height. Key FPS difference vs ecctrl: body
faces camera yaw and we *blend strafe*, we don't rotate the model toward movement.

### Wiring (R3F v9 + @react-three/rapier v2)
- Arena: `<RigidBody type="fixed" colliders="trimesh">` around `arena_opt.glb`.
- Player: `<RigidBody type="kinematicPositionBased" colliders={false}><CapsuleCollider args={[halfHeight, radius]} /></RigidBody>` (note arg order: **[halfHeight, radius]**).
- Create controller once: `world.createCharacterController(0.01)` + `enableAutostep/enableSnapToGround/setMaxSlopeClimbAngle/setMinSlopeSlideAngle/setApplyImpulsesToDynamicBodies(true)`; remove on unmount.
- Run movement in `useBeforePhysicsStep` with `dt = world.timestep` (fixed step → framerate-independent).

### Pitfalls
- Capsule catching → keep the 0.01 offset + autostep; simplify collision mesh if the GLB has thin tris.
- Jitter → kinematic avoids solver fighting; keep snap-to-ground + a small downward stick (`vy=max(vy,-1)`) when grounded; damp anim params.
- **Camera-relative input #1 bug**: rotate WASD by camera **yaw only** (flatten pitch) or you drift into the floor.
- **KCC has no gravity** — you must accumulate `vy` yourself.
- Crouch shrinks capsule around its center → lerp height + upward shapecast before standing (block standing under a ceiling).

Sources: ecctrl `src/Ecctrl.tsx`, rapier.rs `/character_controller/`, three-fps `PlayerControls.js`, three-mesh-bvh `example/characterMovement.js`.

---

## 2. Gun firing & combat (semi-auto pistol)

**Insight from three-fps:** fire-rate is gated by a **timer**, not a state; its FSM is
cosmetic (drives anim crossfades only). For **semi-auto** we add an **edge trigger** (fire
on mousedown transition, must release before next shot) on top of the timer.

### Weapon state machine + timings
States: `READY → FIRING → (EMPTY) → RELOADING → READY`.
| Param | Value |
|---|---|
| Mag size | 12 (auto-reload at 0) |
| Fire interval cap | 0.0833s (~12/s ceiling; player is the real limiter). Sheriff-feel = 0.25s |
| Reload | 0.7s — full fire-lockout, doubles as the lockout timer |
| Trigger | edge: press→1 shot, must release (`triggerConsumed` latch) |

Reload logic (three-fps pattern): early-return if reloading / mag full / no reserve; on
finish transfer reserve→mag; reset recoil accumulator. Auto-reload when ammo hits 0 or on
empty trigger pull.

### fire() pipeline
1. gate on cooldown + ammo (done in update); decrement ammo, update HUD.
2. ray from camera: `camera.getWorldPosition(origin)`, `camera.getWorldDirection(dir)`; apply spread cone to **dir** (not camera).
3. world hit: `three-mesh-bvh` — patch `computeBoundsTree`/`acceleratedRaycast`, `raycaster.firstHitOnly = true`, `geom.computeBoundsTree()` on static meshes. BVH is **static only** (no skinned meshes).
4. player hits: **analytic ray-vs-capsule** per remote player (NOT BVH on skinned meshes); nearest of {world, players} wins (wall blocks player). Headshot if hit.point.y ≥ capsule head threshold.
5. on player hit: send shot to server (unconfirmed), show hitmarker + blood; on world hit: spawn decal.
6. always: muzzle flash + tracer + recoil + sound (client-side, immediate).

### Recoil (the skill curve)
Accumulate per-shot kick that recovers over time → tapping = pinpoint, spamming = climb.
| Param | Value |
|---|---|
| Pitch / shot | +1.3° |
| Yaw rand / shot | ±0.35° |
| Recovery | 9/s exp decay (tap resets in ~0.25s) |
| Spread base / per-shot / max | 0.15° / +0.45° / 3.5° |
| Spread decay | 6/s |
Apply recoil as a **transient offset added to look angles** (so the player can pull down to
counter); never permanently rotate the camera.

### Effects (procedural, pooled — no model files)
- Muzzle flash: additive emissive quad + point light, ~45ms, random spin/scale, opacity = life/MUZZLE_MS. Single persistent object.
- Tracer: thin stretched quad/box muzzle→impact via `lookAt`, ~60ms fade, pool ~16.
- Decal: `DecalGeometry(mesh, point, orientationEuler, size)` oriented to world-space normal (`face.normal.transformDirection(object.matrixWorld)`), `polygonOffset:-4`, `depthWrite:false`, cap ~50 (dispose oldest geometry — decals leak fast).

### Damage / health (Valorant-pistol-scaled, 100 HP)
| | body | head | leg |
|---|---|---|---|
| Pistol | 34 (3-shot kill) | 100 (1-tap) or 68 (2-tap) | 26 |
Health as a reducer; **client predicts effects, server confirms the number** (don't decrement
authoritative HP locally — three-fps "broadcast damage to entity" pattern → becomes a server msg).

### Client-predicted vs server-authoritative (Gambetta)
- Client fires immediately (feel), sends `{seq, t(client est. of server time), origin, dir, targetId?, headshot?}`; treats kills as unconfirmed.
- Server keeps a **ring buffer of player positions** (~64 snapshots @ 64Hz = ~1s), **rewinds** to the shot's `t`, re-runs ray-vs-capsule against rewound capsules, applies damage if hit (never blindly trusts client targetId). Clamp rewind ≤200ms.
- Movement uses the same predict→reconcile→replay loop (per-input `seq`, replay unacked).

Sources: three-fps `Weapon.js`/`WeaponFSM.js`/`PlayerHealth.js`, three-mesh-bvh README, three.js DecalGeometry, Gambetta lag-comp, Valorant damage stats (Dexerto/Dot Esports).

---

## 3. Match flow / game state machine

**Pattern from TOSIOS:** drive the whole flow off **absolute timestamps** (`phase_ends_at`)
and a `switch(phase)` in the tick — not per-frame countdowns (survives lag/restart, trivial
client countdown). **Pattern from XState (astahmer):** phases = states, guarded transitions
(`isEveryoneReady`, `score>=target`), `after` delays for timers; one machine shared
server+client. On SpacetimeDB the **server IS the machine** (a `phase` column + tick reducer).

### Six phases
`LOBBY → CALIBRATION → ROUND_START(freeze) → LIVE → ROUND_END(intermission) → MATCH_END → LOBBY`

| Phase | Entry | Exit trigger |
|---|---|---|
| LOBBY | no spawns | `connected >= 2*teamSize` (or all-ready) |
| CALIBRATION | mark all `calibrated=false`, `ends_at=now+CALIB_MAX` | all calibrated **or** timer |
| ROUND_START | spawn all, reset health/ammo, freeze, `ends_at=now+FREEZE` | timer |
| LIVE | unfreeze, `ends_at=now+ROUND_LEN` | one team 0-alive (event-driven) **or** timer |
| ROUND_END | pick winner, score++, `ends_at=now+INTERMISSION` | timer → score≥target? MATCH_END : ROUND_START |
| MATCH_END | final board, `ends_at=now+POSTGAME` | timer → LOBBY (reset) |

**Win conditions (be explicit):** team wiped = ≥1 member and 0 alive → other team wins
*instantly* (checked in damage/disconnect, mid-timer like CS). Timer tiebreak: more players
alive → else greater aggregate health → else draw (replay). Match: `score >= floor(rounds/2)+1`.

**Timings (from TOSIOS, tune):** FREEZE 5s, ROUND_LEN 75s (60–90), INTERMISSION 5s,
CALIB_MAX 15s, POSTGAME 10s. TOSIOS constants: LOBBY 10s, GAME 90s, players min 2 / max 16, lives 3.

**Join/leave:** connect → restore from `logged_out_player` if present (reconnect keeps
team/score) else new player on the **smaller team** (balance) → spawn slot. Joining
mid-round = spectator until next ROUND_START (don't hot-spawn full-HP into a live round).
Disconnect → copy to `logged_out_player`, despawn, **re-run `check_round_end()`** (a leaver
can wipe a team); if connected <2 → back to LOBBY.

**Client:** subscribe to `match_state` directly (server-authoritative; don't duplicate the
FSM); `switch(phase)` routes UI (Lobby/Calibration/FreezeHud/Hud/RoundResult/FinalScoreboard);
render countdown by diffing `phase_ends_at - now` in a local rAF.

Sources: TOSIOS `Game.ts`/`GameState.ts`/`GameRoom.ts`/`constants.ts`, Blackholio `lib.rs`, astahmer `game.machine.ts`, Stately delayed-transitions/guards docs.

---

## 4. SpacetimeDB FPS implementation

**Two reference repos use OPPOSITE authority models** — and this is the key decision:
- `vibe-coding-starter` = **client-authoritative + cosmetic reconcile** (server trusts
  `client_rot`/`client_animation`, re-runs movement but stores client values; threshold-lerp,
  **no input replay**). Fine for an MMO, **wrong for an FPS**.
- Blackholio = **fully server-authoritative** (client sends only a direction vector; a
  scheduled reducer integrates all positions). **Use this authority model** + the starter's
  battle-tested connect/subscribe/20Hz-send client code + proper replay reconciliation.

**Package:** `@clockworklabs/spacetimedb-sdk` is **DEPRECATED** (registry says "use
spacetimedb"). Use **`spacetimedb`** (latest 2.4.1, floor 2.0.0). Rust crate `spacetimedb = "2"`.
Pin CLI + crate + npm to the same major.

### Tables (Rust, adapted)
- `player` (+ `logged_out_player` second accessor on same struct): identity(pk), player_id(unique auto_inc), name, team(enum), pos:Vec3, yaw, pitch, vel, health, max_health, ammo, reserve, alive, anim_state:String, last_input_seq, last_processed, respawn_at.
- `player_input` (private): identity(pk), input:InputState — latest input, written by reducer, read by tick (Blackholio style).
- `pos_snapshot` (private, btree index on identity): rewind buffer for lag-comp.
- `match_state` (public singleton id=0): phase(enum), round, score_a, score_b, ends_at.
- `shot_event` / `kill_event` (public **`event`** tables): transient, auto-reaped; client subscribes via `onInsert` for VFX/killfeed.
- Scheduled timer tables: `tick_timer` (sim ~30Hz) + `match_timer` (1Hz) via `#[table(..., scheduled(reducer))]` + `ScheduleAt::Interval`, inserted in `init`.

`InputState` = `#[derive(SpacetimeType)]` struct { move_x, move_z, yaw, pitch, buttons{fire,aim,jump,crouch,reload,sprint}, seq:u32, dt_ms }. `Vec3`/`DbVector2` = SpacetimeType with normalized()/magnitude() (Blackholio `math.rs` template).

### Reducers (Rust skeletons)
- `init` — insert match_state(0) + scheduled timers.
- `#[reducer(client_connected)]` — restore from logged_out if present.
- `#[reducer(client_disconnected)]` — copy to logged_out, delete player+input, `check_round_end`.
- `join(name)` — assign smaller team, spawn, insert player + player_input.
- `update_input(input)` — drop if `seq <= stored`; store latest (tick integrates).
- `fire(aim, client_time, seq)` — gate alive+ammo; decrement; **rewind** each enemy to `client_time` via `pos_snapshot`; ray_vs_capsule; nearest hit → damage (FF off: skip same team); on death set alive=false, respawn_at, kill_event, award point; insert shot_event.
- scheduled `tick(timer)` — integrate movement from stored input (rotate by yaw, server-side), set anim_state, `last_input_seq` (ACK), push pos_snapshot; handle respawn.
- scheduled `match_tick(timer)` — phase transitions on `now >= ends_at`, win conditions.
- **Security:** scheduled reducers reject client calls (`if ctx.sender() != ctx.identity` — and in 2.x they're not client-callable by default).

### Client (TS / R3F)
- `spacetime generate --lang typescript` → `DbConnection`, table types, camelCased reducers.
- Connect: `DbConnection.builder().withUri('ws://localhost:3000').withModuleName('valor-fps').withToken(saved).onConnect(...).build()`; persist token for same-identity reconnect.
- Subscribe: `conn.db.player.onInsert/onUpdate/onDelete`, `conn.db.shotEvent.onInsert`→tracer, `conn.db.killEvent`→killfeed, `conn.db.matchState.onUpdate`→HUD; `subscriptionBuilder().subscribe(['SELECT * FROM player', ...])`.
- **20Hz input send** (starter's throttle): rAF loop, every 50ms `seq++`, `conn.reducers.updateInput(input)`, push to a `pending[]` ring buffer. Fire on click via separate `conn.reducers.fire(...)` (not gated by movement cadence).
- **LOCAL prediction + replay** (the piece the starter lacks): predict every frame from live input (same integrate() math as server tick); on server `onUpdate` for self, drop acked inputs (`seq <= last_input_seq`), snap to server pos, **replay remaining pending inputs**. (Starter's lighter fallback: lerp toward serverPos by 0.15 when error > 0.4.)
- **REMOTE interpolation**: buffer snapshots per player, render at `now - 100ms`, lerp/slerp between the two bracketing snapshots (not just lerp-to-latest).
- **anim_state**: round-trips as a string column → drive drei `useAnimations` (`prev.fadeOut(0.15); next.reset().fadeIn(0.15).play()`). Local player can drive anim from predicted input a frame early.
- R3F perf: read hot state in `useFrame` via a zustand-mirrored ref (write rows into zustand in onInsert/onUpdate), not React state, to avoid re-rendering the canvas every tick; HUD/menus use hooks directly.

### Dev setup
`curl -sSf https://install.spacetimedb.com | sh` (win: `iwr https://windows.spacetimedb.com -useb | iex`) → `spacetime start` (:3000) → `spacetime build` → `spacetime publish valor-fps` (`-c` wipes data on schema change) → `spacetime generate --lang typescript --out-dir client/src/generated` → `spacetime logs valor-fps -f`.

### 2.0 breaking changes to watch
New v2 WS protocol (regen bindings); `ctx.sender()`/`connection_id()` are **methods** not fields; reducer callbacks → **event tables**; scheduled reducers not client-callable; regenerate TS types after every upgrade.

Sources: vibe-coding-starter `server/src/{lib,common,player_logic}.rs` + `client/src/{App.tsx,components/Player.tsx}`, Blackholio `server-rust/src/{lib,math}.rs`, SpacetimeDB TS-client / CLI / install docs, v2.0.1 release notes.

---

## 5. Webcam body-control (MediaPipe)

**Key facts:** `PoseLandmarker` returns `landmarks` (normalized image coords) AND
`worldLandmarks` (meters, **origin = hip midpoint**). `GestureRecognizer` returns
`gestures[h][0].{categoryName, score}` incl. `Open_Palm`/`Closed_Fist` + 21 hand landmarks +
handedness. BlazePose indices: 0 nose, 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips.

**Crucial split:** world frame is hip-centered → it **can't see crouch** (whole-body vertical
translation). So **lean/strafe from worldLandmarks** (shoulder-vs-hip offset in meters,
position-invariant); **crouch from normalized image landmarks** (body sinks in frame).

**Cadence (corrected):** run **Gesture every frame** (aim+fire need responsiveness; it returns
hand landmarks AND classification in one call) and **Pose throttled ~18Hz** (torso is slow).
Guard on `video.currentTime !== lastVideoTime` + strictly-increasing `performance.now()`
timestamp (VIDEO mode throws on equal/stale ts). Warm up one throwaway inference before
calibration (first call compiles GPU shaders, spikes 100s of ms).

### Detection algorithms + thresholds
| Control | Source | Enter | Exit | Notes |
|---|---|---|---|---|
| Fine aim | aim-hand wrist+tip (norm, mirrored) | >6% deadzone | — | One-Euro minCutoff 0.8, beta 0.03 (x & y) |
| Edge turn | aim offset_x | ≥35% | <35% | 150ms dwell, re-zero on re-entry, ramp→120°/s |
| Fire | off-hand `Closed_Fist` score | ≥0.60 ×2 frames | reopen `Open_Palm` ≥0.50 | latch: one shot/squeeze, 120ms cooldown |
| Reload | aim-hand `Closed_Fist` | ≥0.60 held 500ms | any non-fist / motion | wrist vel < 0.15/s |
| Strafe L/R | world (sh.x−hp.x)/torso | ±15% | ±10% | Schmitt hysteresis |
| Fwd/Back | world (sh.z−hp.z)/torso | ±18% | ±12% | — |
| Crouch | norm shoulder-Y drop / torso | −15% | −8% | torso tilt <20° (separates crouch from lean) |

**One-Euro filter** (Casiez ref, BSD-3): adaptive low-pass — `alpha = 1/(1+tau/te)`,
`cutoff = minCutoff + beta*|dx|`. Tune: beta=0, lower minCutoff till still-hand jitter gone,
raise beta till fast moves don't lag. Crosshair landing: minCutoff 0.8, beta 0.03.

**Fire** = per-hand Schmitt-latched FSM (`ARMED → FIRED_WAIT_OPEN`): N fist frames + cooldown
→ one-frame pulse → must see Open_Palm to re-arm. **Reload** = wall-clock timer on sustained
fist + low wrist velocity. **Crouch** torso-vertical check (tilt<20°) distinguishes knee-bend
from forward-lean.

**Calibration (3s):** discard first 0.5s, average rest. Capture world `neutralLat/neutralFwd/
torsoLenWorld`, normalized `standingShoulderY/torsoLenNorm`, aim-hand bbox (center+halfRange),
and aim-hand handedness label (other hand = fire). All runtime values are deltas / torso-length
→ body-size & distance invariant.

**Mirror caveat:** mirror video for display → flip aim x; MediaPipe handedness is for the
un-mirrored image (user's right ≈ "Left") → capture the label at calibration, don't hardcode.

### The `Controls` contract (input-source-agnostic)
One zustand `Controls` object a keyboard handler could equally produce, so movement/weapon code
never knows the source: `{ yawDelta, pitchDelta, moveForward/Back, strafeLeft/Right, crouch
(level-held booleans like WASD), firePressed/reloadPressed (one-frame edge pulses like keydown),
tracked }`. The vision loop calls `pushControls(...)`; the movement/weapon controllers read
`useControls.getState()` in `useFrame`. Keyboard fallback writes the SAME store → game identical.
Maps 1:1 onto the studio clips (walking, strafe_left/right, crouch_idle, firing, reloading).

**React/perf:** own `useVision()` hook (getUserMedia → loop → store → teardown). Web-worker
offload (createImageBitmap + transferable postMessage) only if the R3F scene stutters.

Sources: MediaPipe Pose/Gesture web guides, tasks-vision npm, casiez/OneEuroFilter, Jamesun921/cam-run `pose.js`, Zaleos camera-controller blog, smoothing-filters article.

---

## 6. Master build order

1. **Single-player game scene** — Rapier KCC + `arena_opt.glb` trimesh, character walks/strafes/crouches, **build the animation blender** (§1 anim params), third-person cam. Renders `Arena()` + `Scatter`. No server/webcam.
2. **First-person + gun** — FPP cam, gun in view, weapon FSM + fire pipeline + hitscan (§2), recoil + muzzle/tracer/decal FX, crosshair/hitmarker.
3. **MediaPipe body control** — `useVision()` + the `Controls` contract (§5) replaces keyboard; 3s calibration; aim/fire/reload/lean/crouch.
4. **SpacetimeDB** — Blackholio authority model + starter client code (§4); tables/reducers; predict→replay + 100ms interpolation; server-side hitscan rewind.
5. **Spectator + AI caster** — read-only `match_state`/event subscriptions for big screen + phones; canned TTS barks then streamed LLM commentary.

### The contract to build against now (Step 1–2)
The `Controls` interface (§5) is the seam: build movement + weapon to consume it; feed it from
keyboard first, MediaPipe later, network-replicated inputs after that — the game logic never
changes. The animation blender (§1) is the keystone every step feeds.
