// ─────────────────────────────────────────────────────────────────────────
// hitscan.ts — one-shot ray resolution against the static world AND the live
// player capsules, per Game-Logic-Deep-Dive §2 (fire pipeline steps 3-4).
//
// §2 splits a shot into two independent tests whose NEAREST result wins (so a
// wall correctly blocks a bot standing behind it):
//
//   3. WORLD (static geometry) — three-mesh-bvh. We patch BufferGeometry /
//      Mesh once at module load (computeBoundsTree / disposeBoundsTree /
//      acceleratedRaycast), then `registerWorld(root)` builds a BVH on every
//      static mesh and remembers it. A THREE.Raycaster with `firstHitOnly` runs
//      against those meshes — O(log n) instead of O(tris). BVH is STATIC ONLY;
//      we never raycast the skinned characters (their geometry is deformed on
//      the GPU and a CPU BVH would be stale).
//
//   4. PLAYERS — analytic ray-vs-capsule. For each alive enemy we fetch its
//      world hit-capsule (capsuleFor) and run a closed-form ray↔segment test:
//      the shot hits iff the closest distance between the ray and the capsule's
//      core segment is ≤ radius; we return the entry distance `t` along the ray.
//      No allocations in the hot path — all temporaries live at module scope.
//
// The local player is skipped (id === LOCAL_ID): you can't shoot yourself.
// `clearWorld()` disposes the BVHs and empties the registry on arena unmount.
// ─────────────────────────────────────────────────────────────────────────

import {
  BufferGeometry,
  Mesh,
  type Object3D,
  Raycaster,
  Vector3,
} from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { type HitResult, type RaycastShot, LOCAL_ID } from "./contracts";
import { capsuleFor, useGame } from "./stores";

// ── Patch three-mesh-bvh onto three's prototypes (once, at module load) ────
// After this, `geometry.computeBoundsTree()` builds an accelerated BVH and any
// Raycaster transparently uses it. Guarded so a hot-reload can't double-patch.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

// ── World registry ─────────────────────────────────────────────────────────
// The static meshes the shot ray tests against. Populated by GameScene once the
// arena has loaded; emptied on unmount.
const worldMeshes: Mesh[] = [];

const raycaster = new Raycaster();
raycaster.firstHitOnly = true;

/** Traverse `root`, build a BVH on every static `Mesh`, and register it as a
 *  hitscan target. Call once after the arena mounts. */
export function registerWorld(root: Object3D): void {
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if ((o as Mesh).isMesh) {
      const m = o as Mesh;
      // Skinned meshes deform on the GPU — a CPU BVH would be wrong (§2 step 3).
      if ((m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
      if (m.geometry && !m.geometry.boundsTree) m.geometry.computeBoundsTree();
      if (!worldMeshes.includes(m)) worldMeshes.push(m);
    }
  });
}

/** Dispose every registered BVH and empty the registry (arena unmount). */
export function clearWorld(): void {
  for (const m of worldMeshes) m.geometry?.disposeBoundsTree?.();
  worldMeshes.length = 0;
}

// ── Module-scope temporaries (keep the hot path allocation-free) ───────────
const rOrigin = new Vector3();
const rDir = new Vector3();
const segBase = new Vector3();
const segTip = new Vector3();
const segDir = new Vector3(); // capsule core direction (base→tip)
const w0 = new Vector3(); // origin - base
const closestPt = new Vector3(); // closest point on the ray to the segment
const hitPoint = new Vector3();
const hitNormal = new Vector3();
const segClosest = new Vector3();

// ── Analytic ray-vs-capsule ────────────────────────────────────────────────
// Finds the nearest distance `t ≥ 0` along the ray (origin + t·dir, |dir|=1)
// at which it enters the capsule {base, tip, radius}, or -1 on a miss / a hit
// beyond `maxDist`. Approach: find the closest approach between the infinite ray
// and the core SEGMENT (clamped); if that distance ≤ radius the volumes overlap.
// We then take the closest-on-ray parameter as the entry `t` — exact enough for
// gameplay (the surface entry is within `radius` of it) and branch-light.
function rayCapsule(maxDist: number, radius: number): number {
  // s = ray param (≥0), u = segment param ([0,1]).
  segDir.subVectors(segTip, segBase);
  w0.subVectors(rOrigin, segBase);

  const a = rDir.dot(rDir); // = 1 (dir is unit) but kept general
  const b = rDir.dot(segDir);
  const c = segDir.dot(segDir);
  const d = rDir.dot(w0);
  const e = segDir.dot(w0);
  const denom = a * c - b * b;

  let s: number;
  let u: number;
  if (denom < 1e-8) {
    // Ray ~parallel to the capsule axis: clamp segment param to its start.
    s = -d / a;
    u = 0;
  } else {
    s = (b * e - c * d) / denom;
    u = (a * e - b * d) / denom;
  }
  // Clamp the segment param to the actual core segment, then re-solve s.
  if (u < 0) u = 0;
  else if (u > 1) u = 1;
  s = (b * u - d) / a;
  if (s < 0) s = 0;

  // Closest points on the (clamped) ray and segment.
  closestPt.copy(rDir).multiplyScalar(s).add(rOrigin);
  segClosest.copy(segDir).multiplyScalar(u).add(segBase);
  const distSq = closestPt.distanceToSquared(segClosest);
  if (distSq > radius * radius) return -1; // miss
  if (s > maxDist) return -1; // hit is past the gun's reach
  return s;
}

// ── The contract impl ──────────────────────────────────────────────────────
export const raycastShot: RaycastShot = (origin, dir, maxDist) => {
  rOrigin.set(origin[0], origin[1], origin[2]);
  rDir.set(dir[0], dir[1], dir[2]).normalize();

  // ── World (BVH) — nearest static intersection within maxDist ────────────
  let world: HitResult | null = null;
  if (worldMeshes.length > 0) {
    raycaster.set(rOrigin, rDir);
    raycaster.far = maxDist;
    const hits = raycaster.intersectObjects(worldMeshes, true);
    if (hits.length > 0) {
      const h = hits[0]; // firstHitOnly + intersectObjects sort ⇒ nearest
      hitNormal.set(0, 1, 0);
      if (h.face && h.object) {
        hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      }
      world = {
        kind: "world",
        point: [h.point.x, h.point.y, h.point.z],
        normal: [hitNormal.x, hitNormal.y, hitNormal.z],
        distance: h.distance,
      };
    }
  }

  // ── Players — nearest alive enemy capsule within maxDist ────────────────
  let bestEntity: HitResult | null = null;
  let bestT = world ? world.distance : maxDist; // already-found world hit is the cap
  const entities = useGame.getState().entities;
  for (const id in entities) {
    const e = entities[id];
    if (!e.alive || e.id === LOCAL_ID) continue;
    const cap = capsuleFor(id);
    if (!cap) continue;
    segBase.set(cap.base[0], cap.base[1], cap.base[2]);
    segTip.set(cap.tip[0], cap.tip[1], cap.tip[2]);
    const t = rayCapsule(bestT, cap.radius);
    if (t < 0) continue;
    // Strictly nearer than the current best (world hit or a closer capsule).
    if (t < bestT) {
      bestT = t;
      hitPoint.copy(rDir).multiplyScalar(t).add(rOrigin);
      // Surface normal: from the capsule core toward the impact point.
      const u = clamp01(projectOnSegment());
      segClosest.copy(segDir).multiplyScalar(u).add(segBase);
      hitNormal.subVectors(hitPoint, segClosest);
      if (hitNormal.lengthSq() < 1e-8) hitNormal.copy(rDir).multiplyScalar(-1);
      hitNormal.normalize();
      bestEntity = {
        kind: "entity",
        entityId: e.id,
        point: [hitPoint.x, hitPoint.y, hitPoint.z],
        normal: [hitNormal.x, hitNormal.y, hitNormal.z],
        distance: t,
      };
    }
  }

  // ── Nearest wins ────────────────────────────────────────────────────────
  if (bestEntity && (!world || bestEntity.distance < world.distance)) return bestEntity;
  return world;
};

// Project the current `hitPoint` onto the current capsule segment (segBase→segTip,
// stored in segDir) and return the raw (un-clamped) param along it.
function projectOnSegment(): number {
  w0.subVectors(hitPoint, segBase);
  const c = segDir.dot(segDir);
  return c < 1e-8 ? 0 : segDir.dot(w0) / c;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
