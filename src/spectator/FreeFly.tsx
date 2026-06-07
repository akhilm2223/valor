// FreeFly — phone / desktop touch-friendly spectator camera.
//
// Same scene + overlays as CasterCam, but adds drei's OrbitControls so the
// viewer can drag-to-orbit and pinch-to-zoom. Useful for the "spectator on
// their phone" demo path.
//
// Behaviour:
//   • On a touch-capable device → mount OrbitControls (touch rotate + pinch).
//   • On desktop → still mount OrbitControls for trackpad/mouse orbit. The
//     hint footer just explains the difference.

import { useMemo } from "react";
import { OrbitControls } from "@react-three/drei";
import { CasterCam } from "./CasterCam";

// Heuristic for "is this a touch device" so the footer hint reads right.
function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "ontouchstart" in window ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
  );
}

export function FreeFly() {
  const touch = useMemo(() => isTouchDevice(), []);
  return (
    <CasterCam
      // Start a bit further out so the user has room to orbit before they
      // bump the near/far clip.
      cameraPosition={[0, 22, 22]}
      cameraExtras={
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.1}
          minDistance={6}
          maxDistance={80}
          maxPolarAngle={Math.PI / 2.05}
          // Both mouse + touch already work by default in drei; we just want
          // a comfortable rotation speed.
          rotateSpeed={0.7}
        />
      }
      footerHint={touch ? "drag to orbit · pinch to zoom" : "drag to orbit · scroll to zoom"}
    />
  );
}
