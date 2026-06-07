// ─────────────────────────────────────────────────────────────────────────
// ThirdPersonCam.tsx — REMOVABLE first-person ⇄ third-person camera toggle.
//
// Press `V` to swing the camera to an over-the-shoulder/orbit view that shows
// the local player's animated body; press again to return to first-person.
// This is the only "dev / spectator" piece of the animation feature.
//
// REMOVABILITY: everything third-person lives in THIS file + viewMode.ts. When
// `third === false` we leave the camera entirely to PlayerController (it owns
// position+rotation), only maintaining the body-vs-viewmodel layer split. So
// deleting this file + viewMode.ts + the GameScene mount leaves a clean,
// MP-ready first-person game with nothing to unpick.
//
// ORDERING (load-bearing): PlayerController writes the camera each physics step;
// Weapon adds recoil in useFrame(priority 10); GameScene renders in
// useFrame(priority 1000). Our override runs at priority 11 — AFTER recoil,
// BEFORE render — so in third-person we cleanly stomp PlayerController's and
// Weapon's camera writes for that frame, and in first-person we touch only
// layers, never the transform.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { LAYER_OWN_BODY, LAYER_VIEWMODEL } from "./layers";
import { LOCAL_ID } from "./contracts";
import { transforms } from "./stores";
import { useViewMode } from "./viewMode";

// Third-person camera placement, relative to the player's capsule center.
const BACK = 3.5; // m behind the player (along +behind)
const UP = 1.2; // m above the capsule center
const LOOK_UP = 0.6; // m above center to aim at (≈ head height)

export function ThirdPersonCam() {
  // Own the toggle key so removal is self-contained: `V` flips view mode.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "KeyV") useViewMode.getState().toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reusable scratch (keep the hot path allocation-free).
  const tmp = new Vector3();

  useFrame((state) => {
    const camera = state.camera;
    const third = useViewMode.getState().third;

    if (!third) {
      // First-person: PlayerController owns the camera transform. We only keep
      // the FPS layer split (show the viewmodel, hide the local body).
      camera.layers.disable(LAYER_OWN_BODY);
      camera.layers.enable(LAYER_VIEWMODEL);
      return;
    }

    const t = transforms[LOCAL_ID];
    if (!t) return;

    const [cx, cy, cz] = t.pos; // capsule CENTER
    const yaw = t.yaw;
    // Player faces (-sin yaw, 0, -cos yaw); "behind" is the opposite.
    const behindX = Math.sin(yaw);
    const behindZ = Math.cos(yaw);

    tmp.set(cx + behindX * BACK, cy + UP, cz + behindZ * BACK);
    camera.position.copy(tmp);
    camera.lookAt(cx, cy + LOOK_UP, cz);

    // Show the body, hide the viewmodel (WORLD is layer 0 — always on).
    camera.layers.enable(LAYER_OWN_BODY);
    camera.layers.disable(LAYER_VIEWMODEL);
  }, 11);

  return null;
}
