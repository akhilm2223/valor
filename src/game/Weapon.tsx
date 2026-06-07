// ─────────────────────────────────────────────────────────────────────────
// Weapon.tsx — the local player's semi-auto pistol: the §2 fire pipeline,
// the (cosmetic) weapon FSM, recoil/spread, and the first-person viewmodel.
//
// Design (Game-Logic-Deep-Dive §2):
//
//   • FSM is COSMETIC. Fire rate is gated by a TIMER (`cooldown`), not by the
//     READY→FIRING→EMPTY→RELOADING→READY state — exactly the three-fps insight.
//     Semi-auto = an EDGE trigger on top of the timer: one shot per `firePressed`
//     pulse, with a `triggerConsumed` latch so a stuck pulse can't auto-repeat.
//
//   • THIS COMPONENT IS THE SOLE CONSUMER that clears the `firePressed` /
//     `reloadPressed` one-frame edge pulses on useControls (per the contract).
//
//   • Reload (0.7s) is a full fire-lockout; mag = MAG_SIZE (12); auto-reload
//     when ammo hits 0. On finish: ammo = MAG_SIZE, recoil accumulator reset.
//
//   • fire(): decrement ammo via useGame.patch (NEVER touch health — that's
//     combat.applyDamage's job); flag fireState:"firing" briefly for the anim
//     arbiter; build the ray from the CAMERA, apply the spread cone to the RAY
//     DIRECTION (not the camera); raycastShot → on an entity hit, deal
//     SHOT_DAMAGE through combat. Always: muzzle flash + tracer + recoil kick.
//
//   • Recoil is a TRANSIENT additive offset on the camera look angles so the
//     player can pull down to counter it (§2 "skill curve"): pitch +1.3°/shot,
//     yaw ±0.35°/shot, exp recovery 9/s; spread base 0.15° +0.45°/shot, max
//     3.5°, decay 6/s.
//
//   CAMERA WRITE (load-bearing): PlayerController writes the look base into
//   transforms[LOCAL_ID] (pitch/yaw) inside useBeforePhysicsStep — which fires
//   only on a fixed-1/60 physics step, NOT every render frame. So our LATE
//   useFrame(priority 10) SETS rotation = base + decaying recoil from that
//   transform each frame (idempotent), rather than `+=` onto whatever the camera
//   held — `+=` leaks an offset on render frames that had no physics step (>60Hz
//   monitors), making the view/gun drift and refuse to hold still. The viewmodel
//   is then hung off the final camera pose in the same loop so the gun tracks aim
//   and recoil exactly.
// ─────────────────────────────────────────────────────────────────────────

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { MathUtils, type PerspectiveCamera, Quaternion, Vector3 } from "three";
import { LOCAL_ID, MAG_SIZE, SHOT_DAMAGE, type Vec3 } from "./contracts";
import { transforms, useControls, useGame } from "./stores";
import { raycastShot } from "./hitscan";
import { combat } from "./combat";
import { vfx } from "./vfx";
import { FpvArms } from "./FpvArms";
import { playSfx } from "./sfx";
import { getLock } from "./aimAssist";

// ── Tunables (§2 tables) ───────────────────────────────────────────────────
const FIRE_INTERVAL = 0.25; // s — "Sheriff feel" cap
const RELOAD_TIME = 0.7; // s — full fire-lockout
// Aim-down-sights zoom (controls.aiming; vision = one eye closed).
const NORMAL_FOV = 75; // matches the Canvas camera fov
const SCOPED_FOV = 40; // zoomed-in FOV when aiming (~1.9× magnification)
const AIM_LERP = 14; // FOV damp rate (1/s)
const FIRE_ANIM_TIME = 0.12; // s — how long fireState stays "firing"
const MAX_RANGE = 200; // m — shot reach

const DEG = Math.PI / 180;
const RECOIL_PITCH = 1.3 * DEG; // per shot, upward
const RECOIL_YAW = 0.35 * DEG; // per shot, ±random
const RECOIL_RECOVERY = 9; // /s exp decay
const SPREAD_BASE = 0.15 * DEG;
const SPREAD_PER_SHOT = 0.45 * DEG;
const SPREAD_MAX = 3.5 * DEG;
const SPREAD_DECAY = 6; // /s linear decay back toward base

// Barrel-tip offset (muzzle world position for VFX), in the camera's LOCAL frame
// (right = +X, up = +Y, forward = -Z).
const MUZZLE_RIGHT = 0.18;
const MUZZLE_UP = -0.16;
const MUZZLE_FWD = -0.9;


export function Weapon() {
  const camera = useThree((s) => s.camera);

  // ── Per-frame mutable state (refs, never React state) ──────────────────
  const cooldown = useRef(0); // s until next shot allowed
  const reloadTimer = useRef(0); // s remaining in reload (0 = not reloading)
  const fireAnimTimer = useRef(0); // s remaining of the "firing" anim flag
  const triggerConsumed = useRef(false); // edge latch — true while held
  const recoilPitch = useRef(0); // current additive pitch offset (rad)
  const recoilYaw = useRef(0); // current additive yaw offset (rad)
  const spread = useRef(0); // current cone half-angle (rad), atop SPREAD_BASE

  // Reusable temporaries (keep the hot path allocation-free).
  const tmpOrigin = useRef(new Vector3());
  const tmpDir = useRef(new Vector3());
  const tmpMuzzle = useRef(new Vector3());
  const tmpRight = useRef(new Vector3());
  const tmpUp = useRef(new Vector3());
  const tmpQuat = useRef(new Quaternion());

  // ── fire(): the §2 pipeline ────────────────────────────────────────────
  function fire() {
    const g = useGame.getState();
    const me = g.entities[LOCAL_ID];
    const ammo = me ? me.ammo : 0;
    if (ammo <= 0) return;

    // 1. decrement ammo + drive HUD.
    const nextAmmo = ammo - 1;
    g.patch(LOCAL_ID, { ammo: nextAmmo, fireState: "firing" });
    fireAnimTimer.current = FIRE_ANIM_TIME;
    playSfx("shot"); // gunshot crack

    // 2. ray from the camera.
    camera.getWorldPosition(tmpOrigin.current);
    camera.getWorldDirection(tmpDir.current).normalize();
    const origin = tmpOrigin.current;
    const originVec: Vec3 = [origin.x, origin.y, origin.z];

    // 3-4. AIM ASSIST: shoot the LOCKED target (the red ring) — snap the bullet
    // onto it, re-confirming line-of-sight at fire time (a wall that moved in
    // cancels the assist). No lock → manual shot with the spread cone.
    let dirVec: Vec3 = [tmpDir.current.x, tmpDir.current.y, tmpDir.current.z];
    let hit: ReturnType<typeof raycastShot> = null;
    const lock = getLock();
    let assisted = false;
    if (lock) {
      const dx = lock.point[0] - origin.x, dy = lock.point[1] - origin.y, dz = lock.point[2] - origin.z;
      const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
      const ld: Vec3 = [dx * inv, dy * inv, dz * inv];
      const lhit = raycastShot(originVec, ld, MAX_RANGE);
      if (lhit && lhit.kind === "entity" && lhit.entityId && lhit.entityId !== LOCAL_ID) {
        dirVec = ld; hit = lhit; assisted = true; // clean snap onto the locked enemy
      }
    }
    if (!assisted) {
      applySpread(tmpDir.current);
      dirVec = [tmpDir.current.x, tmpDir.current.y, tmpDir.current.z];
      hit = raycastShot(originVec, dirVec, MAX_RANGE);
    }

    // 5. on an entity hit → deal damage through the combat sink.
    if (hit && hit.kind === "entity" && hit.entityId) {
      combat.applyDamage({ targetId: hit.entityId, amount: SHOT_DAMAGE, fromDir: dirVec, byId: LOCAL_ID });
    }

    // 6. always: muzzle flash + tracer + recoil.
    muzzleWorldPos(tmpMuzzle.current);
    const muzzle: Vec3 = [tmpMuzzle.current.x, tmpMuzzle.current.y, tmpMuzzle.current.z];
    vfx.muzzle(muzzle);
    const to: Vec3 = hit
      ? hit.point
      : [origin.x + dirVec[0] * MAX_RANGE, origin.y + dirVec[1] * MAX_RANGE, origin.z + dirVec[2] * MAX_RANGE];
    vfx.tracer(muzzle, to);

    // Recoil kick (transient — recovered in the loop).
    recoilPitch.current += RECOIL_PITCH;
    recoilYaw.current += (Math.random() * 2 - 1) * RECOIL_YAW;
    spread.current = Math.min(SPREAD_MAX - SPREAD_BASE, spread.current + SPREAD_PER_SHOT);

    // Reset cooldown + auto-reload at empty.
    cooldown.current = FIRE_INTERVAL;
    if (nextAmmo <= 0) beginReload();
  }

  // Apply a random cone of half-angle (SPREAD_BASE + spread) to `dir` in place.
  function applySpread(dir: Vector3) {
    const half = SPREAD_BASE + spread.current;
    if (half <= 0) return;
    // Build an orthonormal basis around the shot direction.
    const right = tmpRight.current;
    const up = tmpUp.current;
    // Pick a reference that isn't parallel to dir.
    if (Math.abs(dir.y) < 0.99) up.set(0, 1, 0);
    else up.set(1, 0, 0);
    right.crossVectors(dir, up).normalize();
    up.crossVectors(right, dir).normalize();
    // Uniform-ish sample inside the cone: random angle off-axis ≤ half.
    const ang = half * Math.sqrt(Math.random());
    const roll = Math.random() * Math.PI * 2;
    const sinA = Math.sin(ang);
    dir.multiplyScalar(Math.cos(ang));
    dir.addScaledVector(right, sinA * Math.cos(roll));
    dir.addScaledVector(up, sinA * Math.sin(roll));
    dir.normalize();
  }

  // Begin a reload if allowed (not already reloading, mag not full).
  function beginReload() {
    if (reloadTimer.current > 0) return;
    const me = useGame.getState().entities[LOCAL_ID];
    if (me && me.ammo >= MAG_SIZE) return;
    reloadTimer.current = RELOAD_TIME;
    useGame.getState().patch(LOCAL_ID, { reloading: true, fireState: "reloading" });
    playSfx("reload"); // mag-in / slide-rack
  }

  // World position of the viewmodel barrel tip (for muzzle/tracer origin).
  // Offsets are in the camera's local frame (forward -Z, right +X, up +Y).
  function muzzleWorldPos(out: Vector3) {
    camera.getWorldPosition(out);
    camera.getWorldQuaternion(tmpQuat.current);
    const fwd = tmpDir.current.set(0, 0, -1).applyQuaternion(tmpQuat.current);
    const right = tmpRight.current.set(1, 0, 0).applyQuaternion(tmpQuat.current);
    const up = tmpUp.current.set(0, 1, 0).applyQuaternion(tmpQuat.current);
    out.addScaledVector(fwd, -MUZZLE_FWD);
    out.addScaledVector(right, MUZZLE_RIGHT);
    out.addScaledVector(up, MUZZLE_UP);
  }

  // ── Main update loop (default priority) ────────────────────────────────
  useFrame((_, dt) => {
    const c = useControls.getState();

    // Scope/aim-down-sights: lerp the camera FOV toward zoomed when `aiming`.
    const cam = camera as PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      const targetFov = c.aiming ? SCOPED_FOV : NORMAL_FOV;
      if (Math.abs(cam.fov - targetFov) > 0.05) {
        cam.fov = MathUtils.damp(cam.fov, targetFov, AIM_LERP, dt);
        cam.updateProjectionMatrix();
      }
    }

    // Reload edge: begin a reload, then clear the pulse.
    if (c.reloadPressed) {
      beginReload();
      useControls.setState({ reloadPressed: false });
    }

    // Advance the reload timer; on finish refill + reset recoil accumulator.
    if (reloadTimer.current > 0) {
      reloadTimer.current -= dt;
      if (reloadTimer.current <= 0) {
        reloadTimer.current = 0;
        recoilPitch.current = 0;
        recoilYaw.current = 0;
        spread.current = 0;
        useGame.getState().patch(LOCAL_ID, { ammo: MAG_SIZE, reloading: false, fireState: "ready" });
      }
    }

    // Cooldown timer.
    if (cooldown.current > 0) cooldown.current -= dt;

    // Fire edge: one shot per pulse (triggerConsumed latch), gated by cooldown,
    // ammo and the reload lockout. We are the SOLE clearer of firePressed.
    if (c.firePressed) {
      if (!triggerConsumed.current) {
        triggerConsumed.current = true;
        if (cooldown.current <= 0 && reloadTimer.current <= 0) {
          const me = useGame.getState().entities[LOCAL_ID];
          if (me && me.ammo > 0) fire();
        }
      }
      useControls.setState({ firePressed: false });
    } else {
      // Pulse released → allow the next shot.
      triggerConsumed.current = false;
    }

    // Reset the brief "firing" anim flag.
    if (fireAnimTimer.current > 0) {
      fireAnimTimer.current -= dt;
      if (fireAnimTimer.current <= 0) {
        const me = useGame.getState().entities[LOCAL_ID];
        if (me && me.fireState === "firing") {
          useGame.getState().patch(LOCAL_ID, { fireState: reloadTimer.current > 0 ? "reloading" : "ready" });
        }
      }
    }

    // Recoil recovery (exp toward 0) + spread decay (toward base).
    const recover = Math.exp(-RECOIL_RECOVERY * dt);
    recoilPitch.current *= recover;
    recoilYaw.current *= recover;
    spread.current = Math.max(0, spread.current - SPREAD_DECAY * DEG * dt);
  });

  // ── LATE loop (priority 10): write the FINAL camera rotation ────────────
  // PlayerController writes the look base into transforms[LOCAL_ID] (pitch/yaw)
  // — but it does so in useBeforePhysicsStep, which fires only on a fixed-1/60
  // physics step, NOT every render frame. So we must NOT do `rotation +=` (that
  // leaks/accumulates an offset on the render frames with no step, and the view
  // drifts and won't hold still). Instead we SET rotation = base + recoil from
  // the authoritative transform every frame: idempotent regardless of physics
  // cadence. FpvArms then tracks the camera at priority 11 (after this), so the
  // arms + gun inherit the final look + recoil.
  useFrame(() => {
    if (camera.rotation.order !== "YXZ") camera.rotation.order = "YXZ";
    const t = transforms[LOCAL_ID];
    if (t) {
      camera.rotation.x = t.pitch + recoilPitch.current;
      camera.rotation.y = t.yaw + recoilYaw.current;
      camera.rotation.z = 0;
    } else {
      // No transform yet (first frames): fall back to additive recoil.
      camera.rotation.x += recoilPitch.current;
      camera.rotation.y += recoilYaw.current;
    }
  }, 10);

  // First-person arms hold the gun (the real rigged hands) — see FpvArms.
  return <FpvArms />;
}
