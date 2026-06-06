// Runtime optimization pass for the arena GLB.
// Two things the CLI `optimize` can't do well, done here:
//   1. Per-material alpha audit: decode each baseColor texture's alpha with sharp,
//      flip BLEND->OPAQUE (and drop doubleSided) where the alpha is fully opaque,
//      keep BLEND only for genuine translucency (glass/decals). This kills the
//      transparency-sort + double-sided GPU cost, the real framerate problem.
//   2. dedup + weld + join to collapse meshes/draw calls. NO flatten() — the map
//      has rigged props; flatten bakes node transforms into skinned meshes and
//      produces hard glTF validation errors.
//
// Usage (gltf-transform is installed globally, so run via its node_modules):
//   node optimize.mjs arena_chickengun.glb arena_runtime.glb
// then feed arena_runtime.glb through `gltf-transform webp|resize|draco` (see README).
//
// If imports fail with ERR_MODULE_NOT_FOUND, copy this file next to the global
// gltf-transform install and run it from there, e.g.:
//   GTROOT=$(npm root -g)/.. ; node "$GTROOT/.../optimize.mjs" <in> <out>
// or `npm i -D @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf sharp`.

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, join, weld, prune } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule(),
});

const IN = process.argv[2], OUT = process.argv[3];
if (!IN || !OUT) { console.error("usage: node optimize.mjs <in.glb> <out.glb>"); process.exit(1); }

const doc = await io.read(IN);
const root = doc.getRoot();

const countPrims = () => root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
console.log("BEFORE  meshes:", root.listMeshes().length, "prims(~drawcalls):", countPrims(), "materials:", root.listMaterials().length);

// --- Step 2: per-material alpha audit (decide BEFORE join, since join groups by material) ---
let flippedOpaque = 0, keptMask = 0, keptBlend = 0;
for (const mat of root.listMaterials()) {
  if (mat.getAlphaMode() === "OPAQUE") { mat.setDoubleSided(false); continue; }
  const tex = mat.getBaseColorTexture();
  let minAlpha = 255, hasPartial = false;
  if (tex) {
    try {
      const img = tex.getImage();
      const { data, info } = await sharp(Buffer.from(img)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      for (let i = 3; i < data.length; i += ch) {
        const a = data[i];
        if (a < minAlpha) minAlpha = a;
        if (a > 8 && a < 247) hasPartial = true;
      }
    } catch { /* undecodable -> treat as opaque-safe */ }
  }
  if (minAlpha >= 250) {
    mat.setAlphaMode("OPAQUE"); mat.setDoubleSided(false); flippedOpaque++;   // alpha fully opaque
  } else if (!hasPartial) {
    mat.setAlphaMode("MASK"); mat.setAlphaCutoff(0.5); keptMask++;            // hard cutout (foliage/fence)
  } else {
    keptBlend++;                                                              // genuine translucency (glass)
  }
}
console.log("material audit -> OPAQUE flipped:", flippedOpaque, "| MASK:", keptMask, "| BLEND kept:", keptBlend);

// --- Step 1: merge geometry to collapse draw calls (no flatten — see header) ---
await doc.transform(dedup(), weld(), join({ keepNamed: false }), prune());
console.log("AFTER   meshes:", root.listMeshes().length, "prims(~drawcalls):", countPrims(), "materials:", root.listMaterials().length);

await io.write(OUT, doc);
console.log("wrote", OUT);
