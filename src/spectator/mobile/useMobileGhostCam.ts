// useMobileGhostCam — frame-rate-independent ghost camera. Standard mobile-FPS
// control split: joystick translates (camera-relative), swipe rotates yaw.
//
// Inputs are passed in as refs so the per-frame loop never re-installs and the
// joystick/swipe/button writes never re-render React.
//
// Control model:
//   • Joystick (jx, jy) ∈ [-1, 1]². jy is screen-down-positive (CSS coords).
//     Push up on the stick (jy<0) → forward along current yaw.
//     Push right (jx>0) → strafe right.
//     pos += forward * (-jy) * SPEED * dt + right * jx * SPEED * dt.
//   • Swipe drains yawDeltaRef into yawRef directly (no lerp). One screen-pixel
//     of horizontal drag = SWIPE_SENS radians of yaw. No pitch input — pitch is
//     fixed at a slight downward angle so the user always reads the arena floor.
//   • vy ∈ {-1, 0, +1} from up/down buttons. pos.y += vy * VSPEED * dt, clamped.
//
// Follow lock:
//   • If followTargetIdRef points to a live player, the joystick path is
//     bypassed but swipe still rotates yaw — so swipe-during-lock orbits the
//     camera around the player. Position lerps to
//       player.pos + (-sin(yaw)*FOLLOW_DIST, FOLLOW_HEIGHT, cos(yaw)*FOLLOW_DIST)
//     which puts the camera at FOLLOW_DIST behind the player along yaw and
//     keeps the camera's forward vector aimed at the player.
//   • Caller is responsible for clearing followTargetIdRef when joystick magnitude
//     exceeds FOLLOW_CLEAR_MAG (see MobileSpectator).
//
// The lerp formula `t = 1 - exp(-rate * dt)` is frame-rate independent and
// matches the pattern in src/game/SpectatorCam.tsx:91-94.

import { useFrame, useThree } from "@react-three/fiber";
import { useRef, type MutableRefObject } from "react";
import { Euler, MathUtils, Vector3 } from "three";
import type { Player } from "../../net/Connection";

export interface JoystickVec {
  x: number;
  y: number;
}

export interface GhostCamRefs {
  joystickRef: MutableRefObject<JoystickVec>;
  vyRef: MutableRefObject<number>; // -1 down, 0 idle, +1 up
  /** Accumulated horizontal swipe in pixels since the last frame. Hook drains. */
  yawDeltaPxRef: MutableRefObject<number>;
  /** Accumulated vertical swipe in pixels since the last frame. Hook drains. */
  pitchDeltaPxRef: MutableRefObject<number>;
  followTargetIdRef: MutableRefObject<number | null>;
  playersRef: MutableRefObject<Player[]>;
}

const DEADZONE = 0.05;
const SPEED = 6; // m/s at full joystick deflection — comfortable indoor arena feel
const VSPEED = 6; // m/s for up/down buttons
const SWIPE_SENS = 0.005; // rad per CSS pixel — ~57°/200px drag, feels right on a phone
const Y_MIN = 2;
const Y_MAX = 35;
const PITCH_INIT = -0.18; // initial downward tilt — anchors the world-below feel on first frame
const PITCH_MIN = -1.4; // ~-80°, almost straight down
const PITCH_MAX = 1.4; // ~+80°, almost straight up

const FOLLOW_RATE = 4.0;
const FOLLOW_DIST = 6;
const FOLLOW_HEIGHT = 3;

// Start vantage — same height as CasterCam, further back so the spectator
// sees the arena before they move.
const START_POS: [number, number, number] = [0, 18, 22];

export function useMobileGhostCam(refs: GhostCamRefs) {
  const camera = useThree((s) => s.camera);
  const posRef = useRef(new Vector3(...START_POS));
  const yawRef = useRef(0);
  const pitchRef = useRef(PITCH_INIT);
  const initRef = useRef(false);

  // Reusable scratch vectors to avoid per-frame allocation in the hot loop.
  const fwdRef = useRef(new Vector3());
  const rightRef = useRef(new Vector3());
  const targetPosRef = useRef(new Vector3());
  const eulerRef = useRef(new Euler(0, 0, 0, "YXZ"));

  useFrame((_state, dt) => {
    // Clamp dt — first frame after tab focus can spike.
    const d = Math.min(dt, 0.1);

    if (!initRef.current) {
      camera.position.copy(posRef.current);
      initRef.current = true;
    }

    // Drain swipe accumulators into yaw / pitch — direct, no lerp, so swipe
    // feels crisp. Swipe-down on screen (dy > 0) tilts the camera *down*, so
    // pitch decreases. Pitch clamped to avoid pole flip.
    if (refs.yawDeltaPxRef.current !== 0) {
      yawRef.current += refs.yawDeltaPxRef.current * SWIPE_SENS;
      refs.yawDeltaPxRef.current = 0;
    }
    if (refs.pitchDeltaPxRef.current !== 0) {
      pitchRef.current = MathUtils.clamp(
        pitchRef.current - refs.pitchDeltaPxRef.current * SWIPE_SENS,
        PITCH_MIN,
        PITCH_MAX,
      );
      refs.pitchDeltaPxRef.current = 0;
    }

    const { x: jx, y: jy } = refs.joystickRef.current;
    const mag = Math.hypot(jx, jy);

    let followingPlayer: Player | null = null;
    const followId = refs.followTargetIdRef.current;
    if (followId !== null) {
      const ps = refs.playersRef.current;
      for (const p of ps) {
        if (p.id === followId && p.alive) {
          followingPlayer = p;
          break;
        }
      }
    }

    if (followingPlayer) {
      // Orbit the player at FOLLOW_DIST along the current yaw, FOLLOW_HEIGHT
      // above them. Camera quaternion (computed below) keeps facing -Z in the
      // camera frame, which from this offset points at the player.
      targetPosRef.current.set(
        followingPlayer.position.x - Math.sin(yawRef.current) * FOLLOW_DIST,
        followingPlayer.position.y + FOLLOW_HEIGHT,
        followingPlayer.position.z + Math.cos(yawRef.current) * FOLLOW_DIST,
      );
      const yawT = 1 - Math.exp(-FOLLOW_RATE * d);
      posRef.current.lerp(targetPosRef.current, yawT);
    } else {
      // Joystick: camera-relative translation. Forward = where camera looks
      // (XZ), right = 90° clockwise from forward in XZ.
      if (mag > DEADZONE) {
        fwdRef.current.set(
          Math.sin(yawRef.current),
          0,
          -Math.cos(yawRef.current),
        );
        rightRef.current.set(
          Math.cos(yawRef.current),
          0,
          Math.sin(yawRef.current),
        );
        // jy is screen-down-positive: push UP on stick (jy<0) → move forward.
        posRef.current.addScaledVector(fwdRef.current, -jy * SPEED * d);
        posRef.current.addScaledVector(rightRef.current, jx * SPEED * d);
      }

      // Up/down buttons — independent of joystick.
      const vy = refs.vyRef.current;
      if (vy !== 0) {
        posRef.current.y += vy * VSPEED * d;
      }
    }

    // Clamp Y to keep the spectator in the playable airspace.
    posRef.current.y = MathUtils.clamp(posRef.current.y, Y_MIN, Y_MAX);

    // Apply to camera.
    camera.position.copy(posRef.current);
    eulerRef.current.set(pitchRef.current, yawRef.current, 0, "YXZ");
    camera.quaternion.setFromEuler(eulerRef.current);
  });
}
