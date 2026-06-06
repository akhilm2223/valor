# MOSH — Combat & Netcode Plan (hitscan gun · health · damage · death · 5v5)

*Synthesized 2026-06-06 from `Game-Logic-Deep-Dive.md` §2/§3/§4, `Tech-Stack-Research.md`, and a fresh audit of the current `src/`. Scope: the shooting feature only — "one player fires, the other loses HP across the network, 100 HP, dies after N shots," built to run as a 5v5 (10 real people on their own laptops).*

---

## 0. The one decision that frames everything

**Damage is computed on the SERVER, never the client.** The client predicts the *feel* (muzzle flash, tracer, hitmarker, blood, recoil, sound) the instant you fire; the SpacetimeDB `fire()` reducer decides the *truth* (did it hit, how much HP, who died). The client then reconciles to the server's number. This is non-negotiable: in a webcam FPS a client-side hit is trivially faked — server adjudication is the anti-cheat story and the whole pitch ("pull SpacetimeDB out and there's no hit detection").

Authority model = **Blackholio (fully server-authoritative)**, NOT the vibe-coding-starter's client-authoritative model ("fine for an MMO, wrong for an FPS"). Take Blackholio's authority + the starter's connect/subscribe/20Hz client code + proper replay reconciliation (the piece the starter lacks).

---

## 1. Where we actually are (the honest gap)

Today `src/` is a **test studio** — a character/gun/animation *viewer*. None of the gameplay substrate exists:

| Needed for shooting | Built today? |
|---|---|
| Movement controller (WASD, pointer-lock) | ❌ OrbitControls only |
| Rapier physics / capsule colliders | ❌ not installed |
| Arena collision (`arena_opt.glb` loaded) | ❌ written but rendered nowhere |
| Hitscan / raycast / `three-mesh-bvh` | ❌ not installed |
| SpacetimeDB (`spacetimedb` pkg + module) | ❌ not installed |
| A second / remote player | ❌ single local model |
| Health / ammo / damage state | ❌ none |
| Animation **blending** | ❌ hard-cut single clip only |

**So the shooting *logic* is small (~the `fire()` reducer below). The work is the substrate it rides on.** The plan below is staged so we feel the gun early (local) and only pay the netcode cost once.

---

## 2. Damage model (locked, simplified for first ship)

Per the user: **100 HP, flat 20 damage/shot, 5 shots to kill. No hitboxes.**

This is deliberately simpler than the deep-dive's Valorant table (body 34 / head 100 / leg 26). What it buys us:
- `fire()` step 4 drops the `hit.point.y` head check and the per-zone damage lookup — a capsule hit is just a hit.
- One constant: `DAMAGE = 20`. Kill = `health <= 0`. (`100 / 20 = 5`.)
- We still need **ray-vs-capsule** (players are skinned meshes → can't use BVH on them) — we just don't classify *where* on the capsule.

**Upgrade path (post-MVP, one afternoon):** reintroduce the head/leg threshold and swap the constant for the body/head/leg table — pure addition, no restructuring.

---

## 3. Hitscan mechanics (the "physics" — really just line-vs-capsule)

Hitscan = no projectile travel. On fire, cast one ray from the camera and resolve the first thing it hits:

1. **Ray vs. world** (arena walls/floor) — `three-mesh-bvh`: patch `acceleratedRaycast`, `raycaster.firstHitOnly = true`, `geom.computeBoundsTree()` on the **static** arena mesh. BVH is **static-only**.
2. **Ray vs. each enemy player** — **analytic ray-vs-capsule** per enemy (a few dot products each). **Cannot** use BVH here: players are skinned/animated, geometry deforms every frame, a prebuilt bounds tree is invalid.
3. **Nearest of {world, players} wins** — so a wall correctly blocks a player behind it.
4. **Friendly fire OFF** — skip same-team capsules before the damage step.

**Scale note (5v5):** ray-vs-capsule against up to 9 enemies per shot is trivial (handful of dot products × 9) — *not* flagged as a perf risk anywhere. The heavy path is the world BVH raycast, and that's one cast.

---

## 4. Weapon feel (client-side, immediate)

Semi-auto pistol. Fire-rate gated by a **timer**, not a state; the FSM is cosmetic (drives anim crossfades). Semi-auto adds an **edge trigger** on top.

| Param | Value |
|---|---|
| Mag size | 12 (auto-reload at 0) |
| Fire interval cap | 0.25s ("Sheriff feel"); hard ceiling 0.0833s |
| Reload | 0.7s — full fire-lockout; the reload clip **is** the lockout timer |
| Trigger | edge: press → 1 shot, must release (`triggerConsumed` latch) |

**Recoil** (the skill curve) — apply as a **transient offset to look angles** (player can pull down to counter); never permanently rotate the camera:
| Pitch/shot | Yaw rand/shot | Recovery | Spread base/per-shot/max | Spread decay |
|---|---|---|---|---|
| +1.3° | ±0.35° | 9/s exp decay | 0.15° / +0.45° / 3.5° | 6/s |

---

## 5. Server-authoritative pipeline (the real feature)

### Tables (Rust, SpacetimeDB)
- **`player`** (+ `logged_out_player` accessor): `identity(pk), player_id(auto_inc), name, team(enum), pos:Vec3, yaw, pitch, vel, health, max_health, ammo, reserve, alive, anim_state:String, last_input_seq, last_processed, respawn_at`.
- **`player_input`** (private): latest `InputState`, written by `update_input`, read by `tick`.
- **`pos_snapshot`** (private, btree index on identity): the **rewind buffer** — ~64 snapshots @ ~64Hz ≈ 1s. (10 players × 64 × ~20 bytes ≈ low tens of KB — negligible.)
- **`match_state`** (public singleton id=0): `phase, round, score_a, score_b, ends_at`.
- **`shot_event` / `kill_event`** (public **event** tables, transient/auto-reaped): clients `onInsert` → tracer VFX / killfeed.
- Scheduled timer tables: `tick_timer` (~30Hz) + `match_timer` (1Hz).

### `fire(aim, client_time, seq)` reducer — the whole feature
```
gate: player.alive && player.ammo > 0          // else return
player.ammo -= 1
for each enemy where enemy.team != shooter.team:        // FF off
    rewind enemy capsule to client_time via pos_snapshot // lag comp, clamp ≤200ms
    hit = ray_vs_capsule(aim.origin, aim.dir, rewound_capsule)
    if hit && nearer than world-hit distance:
        enemy.health -= 20
        if enemy.health <= 0:
            enemy.alive = false
            enemy.respawn_at = now + RESPAWN
            set enemy.anim_state = directional death (front/back from shot dir)
            insert kill_event
            award point
        else:
            set enemy.anim_state = "hit"   // flinch — sells the netcode
insert shot_event
check_round_end()                          // a kill can wipe a team mid-timer
```
- **Never trust the client's `targetId`** — the server re-runs the ray itself against rewound capsules.
- **Lag compensation:** the target moved during the round-trip, so the server rewinds every enemy to where they were at the shot's `client_time` (ring buffer), clamped to **≤200ms**. **MVP can skip rewind** — raycast current positions; fine at venue-LAN latency, add rewind only if shots feel like they miss.

### Other reducers
`init` (seed match + timers) · `client_connected` (restore from `logged_out`) · `client_disconnected` (copy to `logged_out`, despawn, **`check_round_end`** — a leaver can wipe a team) · `join(name)` (assign **smaller team**, spawn) · `update_input` (store only, drop if `seq <= stored`) · scheduled `tick` (integrate movement, set anim_state, **ACK via `last_input_seq`**, push `pos_snapshot`, handle respawn) · scheduled `match_tick` (phase transitions on `now >= ends_at`, win conditions).

### Client loop
- **20Hz input send** (`update_input`, `seq++`, push to `pending[]`). `fire(...)` is a **separate** call on the trigger edge — not gated by movement cadence.
- **Predict + replay:** predict locally each frame with the *same* integrate math; on self `onUpdate` drop acked inputs, snap to server pos, replay the rest.
- **Remote interpolation:** render other players at **`now − 100ms`** between the two bracketing snapshots.
- **Health/HUD:** display only server-sent `health` — never decrement locally. Hitmarker shows on local predicted hit but the kill is **unconfirmed** until the server agrees.
- **anim_state** round-trips as a string → drei `useAnimations` crossfade (0.15s).
- **Perf:** mirror hot rows into zustand refs read in `useFrame`; don't re-render the canvas per tick.

### Packages / setup
- **`spacetimedb` v2.4.1** npm (floor 2.0.0); Rust crate `spacetimedb = "2"`. **NOT** `@clockworklabs/spacetimedb-sdk` (deprecated). Pin CLI + crate + npm to the same major.
- `curl -sSf https://install.spacetimedb.com | sh` → `spacetime start` → `spacetime build` → `spacetime publish valor-fps` (`-c` wipes on schema change) → `spacetime generate --lang typescript` → `spacetime logs valor-fps -f`.
- 2.0 gotchas: `ctx.sender()`/`connection_id()` are **methods**; reducer callbacks → **event tables**; scheduled reducers **not client-callable**; regenerate TS bindings after every bump.

---

## 6. 5v5 specifics

- **Teams:** auto-balance to the **smaller team** on join; friendly fire **off**; two spawn sides; **spawn geometry for 10** is an open design item to lock.
- **Win = team elimination, instant & mid-timer** (like CS): `≥1 member && 0 alive → other team wins`. Checked from **both** `fire()` kills and `client_disconnected`. Timer tiebreak: more alive → greater aggregate health → draw. Match: `score >= floor(rounds/2)+1`.
- **Join mid-round = spectator until next ROUND_START** (don't hot-spawn full-HP into a live round). Reconnect restores team/score from `logged_out_player` via persisted token.
- **Match flow (6 phases, driven off absolute `ends_at`):** `LOBBY → CALIBRATION → ROUND_START(freeze) → LIVE → ROUND_END → MATCH_END → LOBBY`. LOBBY exits at `connected >= 2*teamSize` (=10). Timings: FREEZE 5s · ROUND_LEN 75s · INTERMISSION 5s · CALIB 15s.
- **Perf at 10 chars + MediaPipe/laptop** (named risk): CV in a Web Worker · gesture model ~10Hz, pose ~18Hz · low-poly `arena_opt.glb` · cap pixel ratio · no crossfades on distant chars · benchmark on the weakest laptop.
- **Demo ops:** dev/test as 1v1–2v2; the judged demo is a pre-staged 5v5. Pre-recruit 12 (10 + 2 alts) on their own laptops, min-spec (Chrome, recent laptop), Sat-night dress rehearsal on venue wifi (hotspot backup), record the 5v5 video as the failure backup. Fallback ladder **5v5 → 3v3 → 2v2** — the reducers are NvN, the game doesn't care.

---

## 7. Build order (feel it early, pay netcode once)

| Phase | What ships | Difficulty | Proves |
|---|---|---|---|
| **A — Local hitscan** | Pointer-lock FPP cam + a dummy capsule target in the studio. Click → ray-vs-capsule → −20 HP → flinch/ragdoll at 0. `three-mesh-bvh` for the world. No server, no second real player. | Easy (hours) | The gun *feels* right; damage/death logic correct |
| **B — Substrate** | Rapier KCC movement (walk/strafe/crouch) on `arena_opt.glb`; animation blender; `Controls` seam (keyboard now, MediaPipe later). | Medium | A real moving player in a real map |
| **C — 1v1 over SpacetimeDB** | Tables + `fire()` + `update_input` + `tick` + predict/replay + remote interp. Two browsers: you shoot, *their* HP drops, they die at 5 shots. **This is the actual feature.** | Medium | Server-authoritative damage across the wire |
| **D — Lag comp** | `pos_snapshot` ring buffer + ≤200ms rewind in `fire()`. | Medium-hard | Hits land on moving targets |
| **E — 5v5** | Teams, spawns×10, round/match flow, killfeed, spectator. Mostly config on top of C/D — reducers are already NvN. | Medium (ops-heavy) | The judged demo |

**Bottleneck reality:** Phase C's cost is ~90% "stand up the multiplayer skeleton" and ~10% the shoot-and-damage logic the user asked about. The `fire()` reducer in §5 is the small, well-understood core; everything around it (movement, connect/subscribe, a second player rendering) is the work.

---

## 8. Load-bearing constraints to never violate

1. **Authoritative HP lives only on the server.** Client predicts VFX, treats kills as unconfirmed.
2. **Players are never BVH-raycast** (skinned) — ray-vs-capsule is mandatory for the enemy checks.
3. **`update_input` only stores; `tick` integrates and ACKs** via `last_input_seq`.
4. **Team-elimination win is event-driven & instant**, checked from both `fire()` and `client_disconnected`.
5. **Rewind clamped ≤200ms**; render remotes at `now − 100ms`.
6. Package is **`spacetimedb` v2.4.1**, not the deprecated `@clockworklabs` SDK.
