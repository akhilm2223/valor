// ─────────────────────────────────────────────────────────────────────────
// layers.ts — three.js render-layer split for the first-person / third-person
// (and, later, other players') views. A camera only renders objects whose layer
// mask intersects its own.
//
//   LAYER_WORLD     arena, bots, VFX        — every camera
//   LAYER_OWN_BODY  the local player's body — HIDDEN from the player's own FPS
//                                             camera, shown to the 3rd-person
//                                             camera (and other players in MP)
//   LAYER_VIEWMODEL the first-person gun    — ONLY the player's own FPS camera
//
// FPS camera renders {WORLD, VIEWMODEL}; 3rd-person camera renders {WORLD,
// OWN_BODY}. This is the standard FPS split and is inherently MP-correct: your
// viewmodel is yours alone, your body is what everyone else sees.
// ─────────────────────────────────────────────────────────────────────────

import type { Object3D } from "three";

export const LAYER_WORLD = 0;
export const LAYER_OWN_BODY = 1;
export const LAYER_VIEWMODEL = 2;

/** Put `obj` and ALL descendants on exactly layer `n` (replaces the default
 *  layer 0). Cheap; safe to call again as a rig streams in new meshes. */
export function setLayerRecursive(obj: Object3D, n: number) {
  obj.traverse((o) => o.layers.set(n));
}
