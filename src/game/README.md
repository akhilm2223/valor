# `src/game/` — local playable FPS (PASS 1)

A first-person shooter that runs entirely on one machine: walk/strafe/crouch around the
real arena, a hitscan pistol, and shootable bot targets that lose **20 HP/shot** and die on
the **5th** (100 HP). No networking yet — the combat is local but written behind interfaces
so PASS 2 can swap it for a SpacetimeDB server reducer with minimal change. This implements
the gun logic from `../../Game-Logic-Deep-Dive.md` §1–§2.

## Run

```bash
npm run dev        # then open http://localhost:5155/?game   (no ?game = the model studio)
npm test           # headless combat proof (5 shots → dead)
npm run smoke      # headless browser smoke (boots scene, raycasts a live bot, screenshots)
```

Controls: **click** canvas to lock pointer · **WASD** move · **mouse** look · **click** fire ·
**R** reload · **Ctrl/C** crouch.

## Architecture — split by update frequency, one arbiter per concern

The integration seam is `contracts.ts` (frozen types/constants). Two rules everything obeys:

1. **60fps transforms live in a mutable ref store (`transforms` in `stores.ts`), not zustand.**
   Moving never re-renders React. Discrete state (health, ammo, alive, fireState) lives on
   `Entity` in the `useGame` zustand store and is the only thing that triggers HUD updates.
2. **One arbiter per concern.** Movement/weapon/combat *write inputs* (speeds, fireState,
   alive); `resolveAnimState()` alone *decides* the clip; only `AnimatedCharacter` *reads* it.
   Hitscan returns the single nearest hit across world+entities. Combat is the sole owner of
   health/death/respawn.

### Files
| File | Owns |
|---|---|
| `contracts.ts` | Frozen types, `CAPSULE`, locked damage model (100/20/5), `ANIM_CLIPS`, `resolveAnimState` arbiter, `CombatSink`/`RaycastShot` interfaces |
| `stores.ts` | `useControls` + `useGame` (zustand), the `transforms` ref store, `capsuleFor()` (shared hit-capsule) |
| `input.ts` | `<InputController/>` — keyboard/mouse → `useControls`, pointer-lock |
| `PlayerController.tsx` | Rapier kinematic-capsule FPP controller: yaw-only camera-relative movement, self-integrated gravity, crouch, look; writes `transforms[LOCAL_ID]` |
| `fit.ts` | `fitCharacter()` — stand-up/scale/hand-bone fit (extracted from `../Models.tsx`) |
| `AnimatedCharacter.tsx` | Crossfading `AnimationMixer` over `ANIM_CLIPS`; per-clip track fixup; death keeps a scaled hip-Y track |
| `hitscan.ts` | `raycastShot` — three-mesh-bvh world raycast + analytic ray-vs-capsule, nearest wins; `registerWorld`/`clearWorld` |
| `Weapon.tsx` | §2 semi-auto pistol: timer+edge-trigger FSM, recoil (transient camera offset), fire pipeline → `raycastShot` → `combat.applyDamage`; FP viewmodel |
| `combat.ts` | `combat.applyDamage` (the local authoritative sink) + `tickCombat` respawns + `computeDamage` (unit-tested) |
| `Bot.tsx` | `<Bots/>` — spawns shootable patrolling bots, floor-snapped onto the arena via a downward raycast |
| `vfx.tsx` | Pooled muzzle flash + tracer (§2 effects); `vfx` sink + `<Vfx/>` renderer |
| `HUD.tsx` | DOM overlay: crosshair, health, ammo, hitmarker, killfeed |
| `GameScene.tsx` | Wires it all into `<Physics>` + arena; mounts the HUD; `?game` entry (`Game`) |
| `combat.test.ts` | vitest: 4 shots → alive@20, 5th → dead |

## Verification

- **Headless unit:** `npm test` proves the locked damage model deterministically.
- **Headless browser** (`scripts/smoke.mjs`): boots `?game`, asserts no errors, all entities
  spawn, a live point-blank `raycastShot` returns the bot, 5 shots kill it, and the renderer
  draws (>1M triangles) — capturing the WebGL buffer directly (compositor screenshots come out
  blank for accelerated canvases). The aimed frame is written to `/tmp/mosh-game.png`.
- **Human playtest** (the one thing automation can't cover): pointer-lock aim feel, recoil
  climb, crouch, and the death animation drop.

## Known tuning / TODO (PASS 1 honesty)
- `Bot.tsx` `FLOOR_Y`/floor-cast are tuned to `arena_opt.glb`'s plaza (the map has layered
  floors — a long downward ray punches through to a lower layer, so the cast is short and
  starts just above the plaza). New spawn points need the same care.
- `AnimatedCharacter.tsx` `HIP_SCALE` (death hip-Y cm→m) is a nominal `0.01` — eyeball it.
- No upper/lower-body anim masking (full-body clips); decals/screen-shake cut; bots don't
  shoot back. See `../../Combat-Netcode-Plan.md` for the deferred SpacetimeDB pass.
