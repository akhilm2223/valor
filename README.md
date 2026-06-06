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

2. **Performance:** the geometry is light (152K tris) but it's 1469 separate meshes with 50+
   transparent double-sided materials → ~1500 draw calls. That stutters once ~20 networked
   players are added. Optimize before relying on it.

### Optimizing the arena (gltf-transform is already installed globally)

The geometry is already Draco-compressed + instanced; the 24 MB is ~100 uncompressed PNG
textures. The single-command `optimize` only reaches ~10 MB. To get under 5 MB, compress
textures to WebP, cap resolution at 512px, then re-apply Draco (this is what produced the
3.5 MB `arena_opt.glb` the app loads):

```bash
cd mosh/public/models
npx gltf-transform webp   arena_chickengun.glb a.glb --quality 80
npx gltf-transform resize a.glb b.glb --width 512 --height 512
npx gltf-transform draco  b.glb arena_opt.glb
rm a.glb b.glb
```

Result: 24 MB → 3.5 MB, no visible quality loss at demo distance. For sharper textures bump
`--width/--height` to 1024 (lands ~6–8 MB). Or simpler: open in Blender, delete everything
except one courtyard, re-export.

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
