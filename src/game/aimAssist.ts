// ─────────────────────────────────────────────────────────────────────────
// aimAssist.ts — aim-assist TARGET LOCK + safe look aid.
//
// WHY THE OLD SYSTEM SPUN 360° (root causes, not symptoms):
//   1. Magnetism wrote yawDelta in useFrame while PlayerController consumed
//      yawDelta in the physics step — two loops, different rates, fighting.
//   2. Yaw error was computed from XZ projection only, ignoring pitch. With
//      any vertical offset the "yaw fix" pointed the long way around the
//      circle instead of the short path → perpetual horizontal spin.
//   3. No per-frame cap — a persistent ~π error produced full rotations
//      every frame trying to reach a target that needed pitch, not yaw.
//   4. Assist ran during lock "grace" frames toward a stale off-screen point
//      while the lock was already invalid → runaway correction.
//
// FIX: lock picking stays here; look aid runs in PlayerController's physics
// step, applied DIRECTLY to yaw/pitch (never via yawDelta). Aid only when
// the lock is stable (not in grace), total 3D error < 18°, and each step is
// capped at 2° so it can fine-tune but never orbit.
// ─────────────────────────────────────────────────────────────────────────

import { MathUtils } from "three";
import { LOCAL_ID, type Vec3 } from "./contracts";
import { transforms, useGame } from "./stores";
import { raycastShot } from "./hitscan";

const ACQUIRE_COS = Math.cos((8 * Math.PI) / 180);
const KEEP_COS = Math.cos((22 * Math.PI) / 180);
const SWITCH_MARGIN = 1 - Math.cos((3 * Math.PI) / 180);
const ASSIST_RANGE = 32;
const LOSE_GRACE_FRAMES = 8;
const HEAD_OFFSET = 0.7;

// Look aid tunables (applied in PlayerController, not via yawDelta).
const AIM_RATE = 4; // 1/s — gentle fine-tune only
const DEADZONE = 0.003; // rad — stop nudging when essentially on target
const MAX_ASSIST_ANGLE = MathUtils.degToRad(18); // beyond this, player turns manually
const MAX_STEP = MathUtils.degToRad(2); // hard cap per physics step — prevents orbit
const PITCH_LIMIT = MathUtils.degToRad(88);

let lockId: string | null = null;
let lockPoint: Vec3 | null = null;
let loseFrames = 0;
let lockStable = false; // true only when eval succeeded THIS frame (not grace)

function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Forward unit vector from yaw/pitch — matches PlayerController YXZ convention. */
function lookFrom(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return [-cp * sy, sp, -cp * cy];
}

/** Yaw/pitch that look along a world-space direction (|dir| > 0). */
function yawPitchTo(dir: Vec3): { yaw: number; pitch: number } {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len < 1e-6) return { yaw: 0, pitch: 0 };
  const inv = 1 / len;
  const dx = dir[0] * inv, dy = dir[1] * inv, dz = dir[2] * inv;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.asin(MathUtils.clamp(dy, -1, 1)) };
}

function evalTarget(id: string, origin: Vec3, aim: Vec3): { cos: number; point: Vec3 } | null {
  const e = useGame.getState().entities[id];
  if (!e || !e.alive) return null;
  const t = transforms[id];
  if (!t) return null;
  const cx = t.pos[0], cy = t.pos[1], cz = t.pos[2];
  const hx = cx, hy = cy + HEAD_OFFSET, hz = cz;
  const tdx = hx - origin[0], tdy = hy - origin[1], tdz = hz - origin[2];
  const tDist = Math.hypot(tdx, tdy, tdz);
  if (tDist < 1e-3 || tDist > ASSIST_RANGE) return null;
  const tInv = 1 / tDist;
  const toHead: Vec3 = [tdx * tInv, tdy * tInv, tdz * tInv];
  const cos = aim[0] * toHead[0] + aim[1] * toHead[1] + aim[2] * toHead[2];
  const cdx = cx - origin[0], cdy = cy - origin[1], cdz = cz - origin[2];
  const cDist = Math.hypot(cdx, cdy, cdz);
  if (cDist < 1e-3) return null;
  const cInv = 1 / cDist;
  const toCenter: Vec3 = [cdx * cInv, cdy * cInv, cdz * cInv];
  const hit = raycastShot(origin, toCenter, ASSIST_RANGE);
  if (!hit || hit.kind !== "entity" || hit.entityId !== id) return null;
  return { cos, point: [hx, hy, hz] };
}

export function updateLock(origin: Vec3, aim: Vec3): void {
  const prevId = lockId;

  if (lockId) {
    const cur = evalTarget(lockId, origin, aim);
    if (cur && cur.cos >= KEEP_COS) {
      lockPoint = cur.point;
      loseFrames = 0;
      lockStable = true;
      return;
    }
    loseFrames++;
    lockStable = false; // grace: keep ring, but NO look aid toward stale point
    if (loseFrames < LOSE_GRACE_FRAMES) return;
  }

  let best: { id: string; cos: number; point: Vec3 } | null = null;
  for (const id in useGame.getState().entities) {
    if (id === LOCAL_ID) continue;
    const r = evalTarget(id, origin, aim);
    if (!r || r.cos < ACQUIRE_COS) continue;
    if (!best || r.cos > best.cos) best = { id, cos: r.cos, point: r.point };
  }

  if (best && prevId && prevId !== best.id) {
    const prev = evalTarget(prevId, origin, aim);
    if (prev && prev.cos >= ACQUIRE_COS && best.cos - prev.cos < SWITCH_MARGIN) {
      lockId = prevId;
      lockPoint = prev.point;
      loseFrames = 0;
      lockStable = true;
      return;
    }
  }

  if (best) {
    lockId = best.id;
    lockPoint = best.point;
    loseFrames = 0;
    lockStable = true;
  } else {
    lockId = null;
    lockPoint = null;
    loseFrames = 0;
    lockStable = false;
  }
}

export function getLock(): { id: string; point: Vec3 } | null {
  return lockId && lockPoint ? { id: lockId, point: lockPoint } : null;
}

/** True when the lock passed eval this frame (not in grace). Look aid gates on this. */
export function isLockStable(): boolean {
  return lockStable;
}

/** Fine-tune yaw/pitch toward the locked head. Call from PlayerController AFTER
 *  input deltas are applied and updateLock() has run — never via yawDelta. */
export function applyLookAssist(
  yaw: number,
  pitch: number,
  eye: Vec3,
  dt: number,
): { yaw: number; pitch: number } {
  const lock = getLock();
  if (!lock || !lockStable) return { yaw, pitch };

  const dx = lock.point[0] - eye[0];
  const dy = lock.point[1] - eye[1];
  const dz = lock.point[2] - eye[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-3) return { yaw, pitch };

  const aim = lookFrom(yaw, pitch);
  const dot = (aim[0] * dx + aim[1] * dy + aim[2] * dz) / dist;
  const angle = Math.acos(MathUtils.clamp(dot, -1, 1));

  // Large error → don't spin the player around; they turn manually (fingers/mouse).
  if (angle > MAX_ASSIST_ANGLE) return { yaw, pitch };

  const { yaw: wantYaw, pitch: wantPitch } = yawPitchTo([dx, dy, dz]);
  const yawErr = wrapAngle(wantYaw - yaw);
  const pitchErr = wantPitch - pitch;

  const k = 1 - Math.exp(-AIM_RATE * dt);
  let yawStep = Math.abs(yawErr) > DEADZONE ? yawErr * k : 0;
  let pitchStep = Math.abs(pitchErr) > DEADZONE ? pitchErr * k : 0;

  yawStep = MathUtils.clamp(yawStep, -MAX_STEP, MAX_STEP);
  pitchStep = MathUtils.clamp(pitchStep, -MAX_STEP, MAX_STEP);

  return {
    yaw: wrapAngle(yaw + yawStep),
    pitch: MathUtils.clamp(pitch + pitchStep, -PITCH_LIMIT, PITCH_LIMIT),
  };
}
