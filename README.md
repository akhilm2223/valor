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
| `arena_opt.glb` | ~1.6 MB | carved + optimized from below | **Loaded by the app.** One plaza carved out in Blender, joined, WebP@512 + Draco, materials de-transparency'd. **85 draw calls.** Use this. |
| `arena_chickengun.glb` | ~24 MB | **Chicken Gun** (ripped game assets) | Original full town. Kept to re-carve a different section. 1469 meshes, 152K tris, 50+ materials. |
| `optimize.mjs` | — | helper | Per-material alpha audit + mesh join (the runtime pass the CLI can't do). See below. |
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

The committed `arena_opt.glb` was **carved down to one plaza in Blender**, then optimized.
The cheapest mesh is the one that isn't there — the party game only uses one space, so we
deleted ~95% of the town instead of shipping it all. Measured before → after:

| Metric | Original | arena_opt.glb (carved) |
|---|---|---|
| File size | 24 MB | **1.6 MB** |
| Draw calls (~primitives) | 785 | **85** |
| OPAQUE materials | 2 | **49** |
| doubleSided | 103 | **19** |
| BLEND (transparent) | 101 | **19** |

Two separate problems, two separate fixes:
- **Download size (24 MB):** all textures, ~100 uncompressed PNGs → WebP @ 512px + Draco.
- **Runtime framerate (785 draw calls):** carve + join collapses meshes; the per-material
  alpha audit kills the transparency-sort + double-sided GPU cost. This is what lets 20 players run.

### Re-carving a different section (Blender)

This was done by driving Blender over the [BlenderMCP](https://github.com/ahujasid/blender-mcp)
socket (addon listening on `:9876`), but the manual steps are:

1. Import `arena_chickengun.glb`. The town is centered on the origin; playable core is within ~25
   world units (4 junk meshes sit at ~2e13 coords — delete those first, they break the bbox).
2. Delete every mesh whose center is >25 units from origin (or box-select one courtyard by eye).
3. Select all remaining un-rigged meshes → `Ctrl+J` to join (this is the draw-call collapse).
   Leave skinned/rigged props out of the join.
4. Export glTF 2.0 with Draco on, WebP textures.

Then finish with the CLI + the material audit script (`optimize.mjs` does the per-material alpha
decode the exporter won't — it sets glTF `alphaMode`, not just EEVEE blend_method):

```bash
cd mosh/public/models
node optimize.mjs arena_carved.glb arena_audited.glb     # BLEND->OPAQUE where alpha is unused
npx gltf-transform resize arena_audited.glb a.glb --width 512 --height 512
npx gltf-transform draco  a.glb arena_opt.glb
rm a.glb arena_audited.glb arena_carved.glb
npx gltf-transform validate arena_opt.glb                # must say "No errors found"
```

`optimize.mjs` needs gltf-transform's libs on its module path — run it from the global install dir,
or `npm i -D @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf sharp`.

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
