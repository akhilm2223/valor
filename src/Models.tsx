import type * as React from "react";
import { useMemo, useLayoutEffect } from "react";
import { useGLTF } from "@react-three/drei";
import { createPortal } from "@react-three/fiber";
import { Box3, Vector3, Object3D, Quaternion } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

// The Chicken Gun map, carved to one plaza in Blender then optimized: 1.6 MB,
// 85 draw calls (was 24 MB / 785). WebP@512 + Draco + BLEND->OPAQUE material audit.
// Source 24 MB original kept at arena_chickengun.glb. Re-carve: see README "Optimizing the arena".
export function Arena() {
  const { scene } = useGLTF("/models/arena_opt.glb");
  return <primitive object={scene} />;
}

// One of the 3 characters. Swap the path for character_b.glb / clay.glb.
export function Character({ url = "/models/character_a.glb", ...props }: { url?: string } & React.ComponentProps<"group">) {
  const { scene } = useGLTF(url);
  return (
    <group {...props}>
      <primitive object={scene.clone()} />
    </group>
  );
}

// Auto-fit any character GLB to `height` world units, feet at the group origin.
// Models are authored at wildly different scales AND orientations: clay is laid
// flat (raw z=116 is head->toe), while character_a/b are already upright (raw
// y=1.16 is tallest). So we: (1) clone the rig correctly, (2) if Y isn't already
// the tallest axis, rotate the longest axis up to stand it on its feet, (3) scale
// to `height`, (4) recenter X/Z + drop feet (min.y) onto the inner group's y=0.
// WHERE it stands is fully up to the caller's `position` prop — the arena is
// messy carved geometry (overhangs, layered floors) so auto-snapping picked the
// wrong surface; the control panel places it by hand instead.
export function FitModel({
  url,
  height = 3,
  hold,
  holdOffset = [0, 0, 0],
  holdRotation = [0, -Math.PI / 2, -Math.PI / 2],
  holdScale = 1,
  gripCurl = 0,
  ...props
}: {
  url: string;
  height?: number;
  // Optional item to place in the character's right hand (e.g. <Gun/>). It's
  // portaled INTO the hand bone so it tracks the rig; authored at real-world
  // units, then un-scaled by the bone's own scale so size is character-agnostic.
  hold?: React.ReactNode;
  // Fine-tune how the held item sits in the palm (the panel drives these so the
  // gun can be snapped into the grip without code edits). Offset is in metres,
  // rotation in radians, scale is a multiplier on top of the auto hand-scale.
  holdOffset?: [number, number, number];
  holdRotation?: [number, number, number];
  holdScale?: number;
  // How much to curl the right-hand fingers around the grip, 0..1. The rig is in
  // bind pose (straight fingers) and no animation poses the hand, so we bend the
  // finger bones procedurally to make a fist around the gun.
  gripCurl?: number;
} & React.ComponentProps<"group">) {
  const { scene } = useGLTF(url);

  const { object, scale, offset, hand, handScale, fingerBones } = useMemo(() => {
    // SkeletonUtils.clone (not scene.clone) so skinned/rigged meshes keep their
    // own skeleton — a plain clone collapses multi-mesh rigs to the origin.
    const object = cloneSkinned(scene);
    object.updateMatrixWorld(true);
    // Stand it up ONLY if it's lying down (Y not already the tallest axis).
    const raw = new Box3().setFromObject(object).getSize(new Vector3());
    if (raw.y >= raw.x && raw.y >= raw.z) {
      // already upright — leave it
    } else if (raw.z >= raw.x) {
      object.rotation.x = -Math.PI / 2; // Z (head->toe) -> Y
    } else {
      object.rotation.z = Math.PI / 2; // X (head->toe) -> Y
    }
    object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(object); // bounds AFTER standing it up
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const scale = height / (size.y || 1);
    const offset: [number, number, number] = [
      -center.x * scale,
      -box.min.y * scale, // feet (min.y) land on the inner group's y=0
      -center.z * scale,
    ];

    // Find the right-hand bone to hang a held item on, plus the finger joints to
    // curl. These rigs are reduced Mixamo hands: only Thumb + Index bones exist.
    let hand: Object3D | null = null;
    const fingerBones: { bone: Object3D; restQ: Quaternion }[] = [];
    object.traverse((o) => {
      if (!hand && o.name === "mixamorigRightHand") hand = o;
      // Joints 1-3 are the bendable knuckles (4 is the fingertip end — skip it).
      if (/mixamorigRightHand(Thumb|Index)[123]$/.test(o.name)) {
        fingerBones.push({ bone: o, restQ: o.quaternion.clone() });
      }
    });
    // The bone lives at the rig's native scale; the whole model is then scaled by
    // `scale`. A gun authored in real metres must be divided by (scale * boneScale)
    // so it ends up the right physical size in the hand. boneScale ~= the rig's
    // own world scale at the hand.
    const handScale = hand ? 1 / (scale * new Vector3().setFromMatrixScale((hand as Object3D).matrixWorld).x) : 1;

    return { object, scale, offset, hand, handScale, fingerBones };
  }, [scene, height]);

  // Curl the finger joints around the grip. These finger bones extend down their
  // own local +Y, so flexing toward the palm = rotating about local X. We restore
  // the rest orientation then rotateX in the bone's OWN frame, so segments with
  // flipped Euler frames still curl consistently into a fist (a plain rotation.x
  // assignment didn't — the frames alternate sign and cancelled out).
  useLayoutEffect(() => {
    for (const { bone, restQ } of fingerBones) {
      bone.quaternion.copy(restQ);
      bone.rotateX(gripCurl * 1.2); // ~69° max curl per joint
    }
  }, [fingerBones, gripCurl]);

  return (
    <group {...props}>
      <group scale={scale} position={offset}>
        <primitive object={object} />
      </group>
      {/* Portal the held item into the hand bone so it follows the rig. The inner
          group orients a -Z-forward gun to sit in a Mixamo palm + sizes it. */}
      {hold && hand &&
        createPortal(
          // Outer group: bone-space scale so metre units behave. Inner group: the
          // panel-driven offset/rotation/scale that snaps the gun into the grip.
          <group scale={handScale}>
            <group position={holdOffset} rotation={holdRotation} scale={holdScale}>
              {hold}
            </group>
          </group>,
          hand,
        )}
    </group>
  );
}

useGLTF.preload("/models/arena_opt.glb");
useGLTF.preload("/models/character_a.glb");
useGLTF.preload("/models/character_b.glb");
useGLTF.preload("/models/clay.glb");
