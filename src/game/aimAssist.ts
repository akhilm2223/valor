// ─────────────────────────────────────────────────────────────────────────
// aimAssist.ts — the shared aim-assist TARGET LOCK.
//
// Body control can't aim finely, so the game picks WHAT you'll shoot for you and
// shows it (the red ring — see TargetLock). The lock is the enemy nearest your
// crosshair that you have line-of-sight to, with light STICKINESS so it doesn't
// flicker between clustered enemies:
//
//   • ACQUIRE: when unlocked, grab the most-aligned visible enemy within a tight
//     cone (ACQUIRE°). This is "what's under the crosshair".
//   • KEEP: once locked, hold that target until it dies, loses line-of-sight, or
//     leaves a WIDER cone (KEEP°) — i.e. until you deliberately turn away. So a
//     small twitch won't swap targets, but turning to the next enemy will.
//
// Line of sight is proven by a raycast that must hit an ENEMY first (a wall in
// the way blocks it). updateLock() runs every frame (TargetLock); getLock() is
// read by the ring renderer AND Weapon.fire() (which re-confirms LOS on the shot).
// ─────────────────────────────────────────────────────────────────────────

import { LOCAL_ID, type Vec3 } from "./contracts";
import { transforms, useGame } from "./stores";
import { raycastShot } from "./hitscan";

const ACQUIRE_COS = Math.cos((13 * Math.PI) / 180); // tight cone to LOCK a new target
const KEEP_COS = Math.cos((22 * Math.PI) / 180); // wider cone to HOLD the current one
const ASSIST_RANGE = 90; // m

let lockId: string | null = null;
let lockPoint: Vec3 | null = null; // current target's aim point (capsule centre)

/** Evaluate one entity: alignment to `aim` + LOS. Returns null if dead, out of
 *  range, or blocked (a ray toward it hits a wall / another body first). */
function evalTarget(id: string, origin: Vec3, aim: Vec3): { cos: number; point: Vec3; hitId: string } | null {
  const e = useGame.getState().entities[id];
  if (!e || !e.alive) return null;
  const t = transforms[id];
  if (!t) return null;
  const px = t.pos[0], py = t.pos[1], pz = t.pos[2];
  const dx = px - origin[0], dy = py - origin[1], dz = pz - origin[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-3 || dist > ASSIST_RANGE) return null;
  const inv = 1 / dist;
  const dir: Vec3 = [dx * inv, dy * inv, dz * inv];
  const cos = aim[0] * dir[0] + aim[1] * dir[1] + aim[2] * dir[2];
  const hit = raycastShot(origin, dir, ASSIST_RANGE);
  if (!hit || hit.kind !== "entity" || !hit.entityId || hit.entityId === LOCAL_ID) return null;
  return { cos, point: [px, py, pz], hitId: hit.entityId };
}

/** Recompute the lock for this frame (sticky acquire/keep). */
export function updateLock(origin: Vec3, aim: Vec3): void {
  // Best visible enemy within the (tight) acquire cone.
  let best: { id: string; cos: number; point: Vec3 } | null = null;
  for (const id in useGame.getState().entities) {
    if (id === LOCAL_ID) continue;
    const r = evalTarget(id, origin, aim);
    if (!r || r.cos < ACQUIRE_COS) continue;
    if (!best || r.cos > best.cos) best = { id: r.hitId, cos: r.cos, point: r.point };
  }

  // Keep the current target if it's still visible and inside the wider keep cone,
  // UNLESS a different enemy is now clearly more centered (acquire cone) — then
  // hand off so turning toward someone new switches the lock.
  if (lockId) {
    const cur = evalTarget(lockId, origin, aim);
    if (cur && cur.cos >= KEEP_COS) {
      if (best && best.id !== lockId && best.cos > cur.cos) {
        lockId = best.id; lockPoint = best.point; // a better-centered enemy won it
      } else {
        lockPoint = cur.point; // refresh the held target's position
      }
      return;
    }
  }

  // Acquire the nearest-to-crosshair enemy, or clear if none.
  if (best) { lockId = best.id; lockPoint = best.point; }
  else { lockId = null; lockPoint = null; }
}

/** The currently locked target (id + aim point), or null. */
export function getLock(): { id: string; point: Vec3 } | null {
  return lockId && lockPoint ? { id: lockId, point: lockPoint } : null;
}
