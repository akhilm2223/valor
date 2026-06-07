// clean-dist — strip files the game never loads but Vite copies from public/
// into the build. Keeps the deployed bundle lean (and avoids slow/partial CDN
// uploads). Run after `vite build`, before deploying.
//
//   • models/arena_chickengun.glb — 23 MB raw arena; the game loads arena_opt.glb.
//   • animations/*.fbx           — Mixamo source files; the game loads the .glb exports.

import { rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";

function sizeMB(p) {
  try {
    return (statSync(p).size / 1048576).toFixed(2);
  } catch {
    return "0";
  }
}

let freed = 0;
function drop(rel) {
  const p = join(DIST, rel);
  if (!existsSync(p)) return;
  try {
    freed += statSync(p).size;
  } catch {
    /* noop */
  }
  rmSync(p, { force: true });
  console.log(`  removed ${rel}`);
}

console.log("clean-dist: stripping unused assets from the build…");

drop("models/arena_chickengun.glb");

const animDir = join(DIST, "animations");
if (existsSync(animDir)) {
  for (const f of readdirSync(animDir)) {
    if (f.toLowerCase().endsWith(".fbx")) drop(join("animations", f));
  }
}

console.log(`clean-dist: freed ${(freed / 1048576).toFixed(1)} MB`);
