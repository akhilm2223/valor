// useFollowCam — third-person trailing camera for the broadcast view.
//
// Each frame:
//   • Look up the player to follow (by id, from playersRef).
//   • targetYaw = atan2(aim.x, -aim.z) — trails the player's look direction.
//   • Lerp yaw toward target with shortest-arc wrap.
//   • Lerp position toward (player + offset) where offset comes from the
//     current yaw, FOLLOW_DIST behind and FOLLOW_HEIGHT above.
//   • Camera quaternion = Euler(PITCH, yaw, 0, "YXZ").
//
// Reads the active camera via useThree(s => s.camera) so it works inside a
// drei <View> — drei swaps the active camera per view pass.
//
// Pure orbit math, no input refs. Variant of the follow-lock branch in
// src/spectator/mobile/useMobileGhostCam.ts:107-117.

import { useFrame, useThree } from "@react-three/fiber";
import { useRef, type MutableRefObject } from "react";
import { Euler, Vector3 } from "three";
import type { Player } from "../net/Connection";

const PITCH = -0.18;
const YAW_RATE = 5.0; // 1/s
const FOLLOW_RATE = 4.0; // 1/s
const FOLLOW_DIST = 5;
const FOLLOW_HEIGHT = 2.2;

export interface UseFollowCamArgs {
  /** Id of the player to follow. May be null between rounds; the hook idles. */
  playerId: number | null;
  /** Live players array, kept fresh by parent React state — read via ref each
   *  frame so the hook doesn't re-install. */
  playersRef: MutableRefObject<Player[]>;
}

export function useFollowCam({ playerId, playersRef }: UseFollowCamArgs) {
  const camera = useThree((s) => s.camera);

  // Persistent camera state. Initialized to a sky vantage so the first frame
  // doesn't snap from origin.
  const posRef = useRef(new Vector3(0, 12, 14));
  const yawRef = useRef(0);
  const initRef = useRef(false);

  const targetPos = useRef(new Vector3());
  const euler = useRef(new Euler(0, 0, 0, "YXZ"));

  useFrame((_state, dt) => {
    const d = Math.min(dt, 0.1);

    if (!initRef.current) {
      camera.position.copy(posRef.current);
      initRef.current = true;
    }

    if (playerId == null) {
      // Nothing to follow — leave camera where it is. Could idle-orbit
      // here later, but for now stillness is fine.
      return;
    }

    let player: Player | null = null;
    const ps = playersRef.current;
    for (const p of ps) {
      if (p.id === playerId) {
        player = p;
        break;
      }
    }
    if (!player) return;

    // Target yaw trails the player's aim direction.
    const targetYaw = Math.atan2(player.aimVector.x, -player.aimVector.z);
    const yawT = 1 - Math.exp(-YAW_RATE * d);
    yawRef.current = lerpAngle(yawRef.current, targetYaw, yawT);

    // Position lerps toward (player + offset behind along yaw).
    targetPos.current.set(
      player.position.x - Math.sin(yawRef.current) * FOLLOW_DIST,
      player.position.y + FOLLOW_HEIGHT,
      player.position.z + Math.cos(yawRef.current) * FOLLOW_DIST,
    );
    const posT = 1 - Math.exp(-FOLLOW_RATE * d);
    posRef.current.lerp(targetPos.current, posT);

    camera.position.copy(posRef.current);
    euler.current.set(PITCH, yawRef.current, 0, "YXZ");
    camera.quaternion.setFromEuler(euler.current);
  });
}

// Shortest-arc angular lerp (radians). Handles wrap so 359° → 1° doesn't
// unwind the long way around.
function lerpAngle(a: number, b: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  const diff = ((b - a + Math.PI) % TWO_PI) - Math.PI;
  const wrapped = diff < -Math.PI ? diff + TWO_PI : diff;
  return a + wrapped * t;
}
