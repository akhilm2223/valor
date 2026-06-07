// ─────────────────────────────────────────────────────────────────────────
// input.ts — keyboard + mouse producer for the `useControls` store. Mount
// <InputController/> once inside the Canvas. This is the ONLY input source for
// PASS 1; swapping in MediaPipe later means writing the same store from a vision
// loop, with zero changes to movement/weapon code.
//
// Contract reminders (see contracts.ts):
//   • yawDelta/pitchDelta ACCUMULATE here and are zeroed by the consumer
//     (PlayerController) each frame.
//   • firePressed/reloadPressed are ONE-FRAME edge pulses set here on the input
//     event; the SINGLE consumer (Weapon) reads and clears them.
// Pointer lock engages on canvas click; look only applies while locked.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useControls } from "./stores";
import { initAudio } from "./sfx";
import { useLoadout } from "./loadout";

const LOOK_SENS = 0.0022; // radians per pixel of mouse movement

/** R3F component (renders null) that wires DOM input into useControls. */
export function InputController() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const dom = gl.domElement;
    const set = useControls.setState;

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          set({ moveForward: down });
          break;
        case "KeyS":
        case "ArrowDown":
          set({ moveBack: down });
          break;
        case "KeyA":
        case "ArrowLeft":
          set({ strafeLeft: down });
          break;
        case "KeyD":
        case "ArrowRight":
          set({ strafeRight: down });
          break;
        case "ControlLeft":
        case "KeyC":
          set({ crouch: down });
          break;
        case "KeyR":
          if (down) set({ reloadPressed: true });
          break;
        case "KeyG":
          // TEMP debug: swap to the golden gun (→ ray-gun-blast sound). Later
          // this becomes a real pickup, not a key — see loadout.ts.
          if (down) useLoadout.getState().toggleGolden();
          break;
      }
    };
    const onKeyDown = onKey(true);
    const onKeyUp = onKey(false);

    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== dom) return;
      set((s) => ({
        yawDelta: s.yawDelta - e.movementX * LOOK_SENS, // +movementX (right) → yaw decreases (turn right)
        pitchDelta: s.pitchDelta - e.movementY * LOOK_SENS,
      }));
    };
    const onMouseDown = (e: MouseEvent) => {
      initAudio(); // unlock/resume Web Audio on the user gesture (first click)
      if (document.pointerLockElement !== dom) {
        dom.requestPointerLock();
        return;
      }
      if (e.button === 0) set({ firePressed: true });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    dom.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      dom.removeEventListener("mousedown", onMouseDown);
    };
  }, [gl]);

  return null;
}
