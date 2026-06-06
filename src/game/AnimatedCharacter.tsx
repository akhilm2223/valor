// ─────────────────────────────────────────────────────────────────────────
// AnimatedCharacter.tsx — PHASE 0 PLACEHOLDER.
//
// Renders a fitted character in a static pose with an optional held item, so
// bots and scene integration can proceed against the frozen
// `AnimatedCharacterProps` interface. Agent B replaces the body of this file
// with a real crossfading AnimationMixer driven by `animState` (preloading
// ANIM_CLIPS, reusing the ClipPlayer track-fixup, and KEEPING the hip-Y track
// for the death clip while locomotion clips stay in-place). The PROP CONTRACT
// below must not change.
//
// Parent components own world placement (position/rotation via the group props);
// this component only fits + animates the rig.
// ─────────────────────────────────────────────────────────────────────────

import type * as React from "react";
import { useMemo, useLayoutEffect } from "react";
import { useGLTF } from "@react-three/drei";
import { createPortal } from "@react-three/fiber";
import { fitCharacter } from "./fit";
import type { AnimState } from "./contracts";

export interface AnimatedCharacterProps extends React.ComponentProps<"group"> {
  url: string;
  height?: number;
  /** Item to portal into the right hand (e.g. <Gun/>). Authored in metres. */
  hold?: React.ReactNode;
  /** Which clip to play. Resolve via resolveAnimState(); do not pick clips ad-hoc. */
  animState: AnimState;
}

// In-hand transform for the held gun (the "while animating" preset from the
// studio — a clip is always playing in-game so the hand pose matches).
const HOLD_OFFSET: [number, number, number] = [0.04, 0.24, -0.02];
const HOLD_ROTATION: [number, number, number] = [(-277 * Math.PI) / 180, (15 * Math.PI) / 180, (-75 * Math.PI) / 180];
const HOLD_SCALE = 1.2;
const GRIP_CURL = 1;

export function AnimatedCharacter({ url, height = 1.8, hold, animState: _animState, ...props }: AnimatedCharacterProps) {
  const { scene } = useGLTF(url);
  const { object, scale, offset, hand, handScale, fingerBones } = useMemo(() => fitCharacter(scene, height), [scene, height]);

  // Curl the fingers around the grip (placeholder: static fist, no animation).
  useLayoutEffect(() => {
    for (const { bone, restQ } of fingerBones) {
      bone.quaternion.copy(restQ);
      bone.rotateX(GRIP_CURL * 1.2);
    }
  }, [fingerBones]);

  return (
    <group {...props}>
      <group scale={scale} position={offset}>
        <primitive object={object} />
      </group>
      {hold && hand &&
        createPortal(
          <group scale={handScale}>
            <group position={HOLD_OFFSET} rotation={HOLD_ROTATION} scale={HOLD_SCALE}>
              {hold}
            </group>
          </group>,
          hand,
        )}
    </group>
  );
}
