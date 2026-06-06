# MOSH — starter folder

Body-controlled multiplayer party game for the SpacetimeDB hackathon (NY Tech Week, Jun 5–7 2026).
This folder is the **3D + engine starter**: the map, the 3 characters, and a working R3F scene
that loads them. Multiplayer (SpacetimeDB) and pose input are NOT wired yet — see "What's next".

## Run it

```bash
cd mosh
npm install
npm run dev
```

Open http://localhost:5174 — you'll see the Chicken Gun arena with 3 characters standing in it,
orbit-controllable, with an FPS counter (top-left). `host: true` is set so phones/laptops on the
same Wi-Fi can join via your machine's LAN IP (e.g. http://192.168.x.x:5174).

## What's in here

### Engine / config
| File | Purpose |
|---|---|
| `package.json` | React 19 + Vite 6 + R3F + drei + three 0.183 + MediaPipe tasks-vision + zustand. Same stack as the tennis client. |
| `vite.config.ts` | Vite + React plugin, port 5174, LAN-exposed. |
| `tsconfig.json` | Strict TS, bundler resolution. Matches tennis client. |
| `index.html` | Full-screen canvas root. |
| `src/main.tsx` | React entry. |
| `src/App.tsx` | The scene: camera, lights, arena, 3 characters, OrbitControls, Stats. |
| `src/Models.tsx` | `<Arena>` and `<Character url>` GLB loaders + preload. |

### Models (`public/models/`)
| File | Size | Source | Notes |
|---|---|---|---|
| `arena_opt.glb` | ~3.5 MB | optimized from below | **Loaded by the app.** WebP textures @ 512px + Draco. Use this. |
| `arena_chickengun.glb` | ~24 MB | **Chicken Gun** (ripped game assets) | Original. Kept for re-optimizing at higher quality. 1469 meshes, 152K tris, 50+ materials. |
| `character_a.glb` | 1.6 MB | tennis project | Rigged character. |
| `character_b.glb` | 1.7 MB | tennis project | Rigged character. |
| `clay.glb` | 0.7 MB | tennis project (`clay_idle`) | Rigged character, idle pose. |

## ⚠️ Two things to know about the arena

1. **Legal:** `arena_chickengun.glb` is ripped from the mobile game *Chicken Gun*. Fine for a private
   prototype; a liability if the demo is recorded/posted or you win. Swap for a CC0 arena
   (Kenney.nl, Quaternius, poly.pizza) before anything public.

2. **Performance:** geometry is light (152K tris) but the export is ~727 meshes / 785 draw calls,
   and 101 of 103 materials were BLEND + doubleSided. Transparency sorting + double-sided shading is
   the real GPU cost; that stutters once ~20 networked players are added.

### What `arena_opt.glb` already is

The committed `arena_opt.glb` (3.2 MB, loaded by the app) has had the full pass below applied to it.
Measured before → after:

| Metric | Original | arena_opt.glb |
|---|---|---|
| File size | 24 MB | **3.2 MB** |
| Draw calls (~primitives) | 785 | **584** |
| OPAQUE materials | 2 | **71** |
| doubleSided | 103 | **30** |
| BLEND (transparent) | 101 | **30** |

Two separate problems, two separate fixes:
- **Download size (24 MB):** all textures, ~100 uncompressed PNGs → WebP @ 512px + Draco. → 3.2 MB.
- **Runtime framerate:** the merge + material audit below. This is what actually helps 20 players.

### Re-running the optimization

The runtime pass needs a script (CLI `optimize` won't do the per-material alpha audit). It:
1. Decodes each material's baseColor alpha with `sharp`; flips BLEND→OPAQUE (and drops doubleSided)
   where alpha is fully opaque (69 materials), keeps BLEND only for real translucency (glass/decals).
2. `dedup` + `weld` + `join` to collapse meshes/draw calls. **No `flatten()`** — the map has rigged
   props; flatten bakes node transforms into skinned meshes and produces hard glTF errors.

Then the CLI handles textures + final Draco:

```bash
cd mosh/public/models
# 1. runtime pass (material audit + mesh join) -> arena_runtime.glb
node optimize.mjs arena_chickengun.glb arena_runtime.glb
# 2. textures + draco
npx gltf-transform webp   arena_runtime.glb a.glb --quality 80
npx gltf-transform resize a.glb b.glb --width 512 --height 512
npx gltf-transform draco  b.glb arena_opt.glb
rm a.glb b.glb arena_runtime.glb
npx gltf-transform validate arena_opt.glb   # must say "No errors found"
```

**Bigger win, if you have Blender:** carve out one courtyard (delete the rest, Ctrl+J to join,
export with Draco). The cheapest mesh is the one that isn't there — you only use ~5% of this town.
Lands ~2 MB and a few hundred draw calls.

## What's next (not built yet — by design, shotgun-first)

1. **Pose input** — port from `breakpoint-hackathon/client/src/`:
   - `components/PoseTracker.tsx` (MediaPipe webcam → landmarks)
   - `game/OneEuroFilter.ts` (smoothing — keep the tuned constants)
   - For MOSH you mostly need **motion energy** (sum of upper-body landmark deltas) for
     Red-Light-Green-Light, not full retargeting.
2. **SpacetimeDB** — tables `players`, `round`; reducers `join`, `updatePlayerState`, `tick`.
   This is the actual judged criterion. The 3D here is just the input/output layer.
3. **First mini-game** — Red-Light-Green-Light. No locomotion needed: only "moving vs still".

## Stack reference (from the tennis project)
- Pose pipeline files to port: `PoseTracker.tsx`, `OneEuroFilter.ts`, `GestureDetector.ts`
- MediaPipe model: `pose_landmarker_lite` @ 640x480, ~30fps inference
- Use blob/capsule avatars on the big screen for many players, not retargeted skeletons
