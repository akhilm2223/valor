// ─────────────────────────────────────────────────────────────────────────
// FpvArms.tsx — first-person arms = the REAL rigged character holding the gun,
// viewed from its own head. Reuses AnimatedCharacter (the same skinned model +
// gun-in-hand the studio/bots use) so the hands are the actual modeled hands,
// not procedural boxes.
//
// HOW: render the character in a group that tracks the camera every frame (so it
// inherits look + recoil). Drop the rig ~eye-height so the HEAD lands at the
// camera, then COLLAPSE the head/neck bones (scale→0) so the player's own face
// doesn't fill the screen — leaving the aiming-idle arms + gun in view.
//
// animState is driven from the LOCAL entity (resolveAnimState) so the arms idle,
// walk, run, fire and reload like everyone else — the "how it moves" polish.
// ─────────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { type Group, type Object3D } from "three";
import { AnimatedCharacter } from "./AnimatedCharacter";
import { Gun, type GunVariant } from "../Gun";
import { LOCAL_ID, resolveAnimState, type AnimState } from "./contracts";
import { transforms, useGame } from "./stores";

// Rig placement relative to the camera (camera = the eyes). Tuned by eye in FPP.
const RIG_POS: [number, number, number] = [0, -1.55, 0.06]; // drop to head, nudge fwd
const RIG_YAW = Math.PI; // face the same way the camera looks (-Z)
// Bones to collapse so the head/face never blocks the view (the body is one
// skinned mesh, so shrinking these bones shrinks the vertices weighted to them).
const HIDE_BONES = new Set(["mixamorigHead", "mixamorigNeck"]);

interface FpvArmsProps {
  /** Gun variant — caller threads in from the networked player row when the
   *  spectator-voted Golden Gun is awarded. Defaults to "normal". */
  variant?: GunVariant;
}

export function FpvArms({ variant = "normal" }: FpvArmsProps = {}) {
  const root = useRef<Group>(null);
  const rig = useRef<Group>(null);
  const camera = useThree((s) => s.camera);
  const [anim, setAnim] = useState<AnimState>("idle");
  const animRef = useRef<AnimState>("idle");
  const headBones = useRef<Object3D[]>([]);

  // Track the camera (priority 11 = after recoil's priority-10 write), keep the
  // head collapsed, and pick the anim state from the local entity.
  useFrame(() => {
    const g = root.current;
    if (g) {
      g.position.copy(camera.position);
      g.quaternion.copy(camera.quaternion);
    }
    // Collapse head/neck so the player's own face never fills the screen. Find
    // the bones once, then RE-ASSERT every frame — the animation mixer rewrites
    // bone transforms each tick, so a one-shot scale gets clobbered.
    if (headBones.current.length === 0 && rig.current) {
      rig.current.traverse((o: Object3D) => {
        if (HIDE_BONES.has(o.name)) headBones.current.push(o);
      });
    }
    for (const b of headBones.current) b.scale.setScalar(0.0001);
    // Drive the arms from the local player's state (idle/walk/run/fire/reload).
    const e = useGame.getState().entities[LOCAL_ID];
    const t = transforms[LOCAL_ID];
    if (e && t) {
      const s = resolveAnimState(e, t);
      if (s !== animRef.current) { animRef.current = s; setAnim(s); }
    }
  }, 11);

  return (
    <group ref={root}>
      <group ref={rig} position={RIG_POS} rotation={[0, RIG_YAW, 0]}>
        <AnimatedCharacter
          url="/models/character_a.glb"
          animState={anim}
          hold={<Gun length={0.22} variant={variant} />}
        />
      </group>
    </group>
  );
}
