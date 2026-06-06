// ─────────────────────────────────────────────────────────────────────────
// fit.ts — character-fit helper, extracted so the game renderer and the studio
// share one implementation of the subtle bits. Mirrors the logic baked into
// `FitModel` (src/Models.tsx): SkeletonUtils-clone the rig, stand it up if it
// was authored lying down, scale to `height`, drop feet to y=0, and locate the
// right-hand bone (+ finger joints) for holding/curling a gun.
//
// Standalone (does not import the studio) so the game route can't break the
// studio and vice-versa. Agent B's AnimatedCharacter builds its crossfade mixer
// on top of the `object` this returns.
// ─────────────────────────────────────────────────────────────────────────

import { Box3, Vector3, Object3D, Quaternion } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

export interface FittedCharacter {
  /** The cloned, stood-up rig. Mount under a <group scale offset>. */
  object: Object3D;
  scale: number;
  offset: [number, number, number];
  /** Right-hand bone to portal a held item into (null if the rig lacks it). */
  hand: Object3D | null;
  /** Divide a metre-authored held item by this so it's the right size in-hand. */
  handScale: number;
  /** Bendable finger joints + their rest orientation, for procedural grip curl. */
  fingerBones: { bone: Object3D; restQ: Quaternion }[];
}

export function fitCharacter(scene: Object3D, height: number): FittedCharacter {
  // SkeletonUtils.clone (not scene.clone) so skinned meshes keep their skeleton.
  const object = cloneSkinned(scene);
  object.updateMatrixWorld(true);

  // Stand it up only if Y isn't already the tallest axis (some GLBs lie flat).
  const raw = new Box3().setFromObject(object).getSize(new Vector3());
  if (raw.y >= raw.x && raw.y >= raw.z) {
    // already upright
  } else if (raw.z >= raw.x) {
    object.rotation.x = -Math.PI / 2; // Z (head->toe) -> Y
  } else {
    object.rotation.z = Math.PI / 2; // X (head->toe) -> Y
  }
  object.updateMatrixWorld(true);

  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const scale = height / (size.y || 1);
  const offset: [number, number, number] = [-center.x * scale, -box.min.y * scale, -center.z * scale];

  // Right-hand bone + curlable finger joints (reduced Mixamo rig: Thumb+Index).
  let hand: Object3D | null = null;
  const fingerBones: { bone: Object3D; restQ: Quaternion }[] = [];
  object.traverse((o) => {
    if (!hand && o.name === "mixamorigRightHand") hand = o;
    if (/mixamorigRightHand(Thumb|Index)[123]$/.test(o.name)) {
      fingerBones.push({ bone: o, restQ: o.quaternion.clone() });
    }
  });
  const handScale = hand ? 1 / (scale * new Vector3().setFromMatrixScale((hand as Object3D).matrixWorld).x) : 1;

  return { object, scale, offset, hand, handScale, fingerBones };
}
