// ─────────────────────────────────────────────────────────────────────────
// TargetLock.tsx — red-ring indicator for the aim-assist lock.
//
// Lock picking + look aid live in aimAssist.ts / PlayerController (one physics
// step, direct yaw/pitch writes). This component only draws the bracket on the
// locked head so you can see WHO you're snapped onto.
// ─────────────────────────────────────────────────────────────────────────

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { type Group } from "three";
import { getLock } from "./aimAssist";

export function TargetLock() {
  const camera = useThree((s) => s.camera);
  const ref = useRef<Group>(null);

  useFrame(() => {
    const g = ref.current;
    const lock = getLock();
    if (!g) return;

    if (!lock) {
      g.visible = false;
      return;
    }

    g.visible = true;
    g.position.set(lock.point[0], lock.point[1], lock.point[2]);
    g.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={ref} visible={false} renderOrder={999}>
      <mesh>
        <torusGeometry args={[0.5, 0.035, 8, 40]} />
        <meshBasicMaterial color="#ff5a5a" depthTest={false} transparent opacity={0.95} toneMapped={false} />
      </mesh>
      {[0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => (
        <mesh key={a} position={[Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0]} rotation={[0, 0, a]}>
          <boxGeometry args={[0.16, 0.05, 0.001]} />
          <meshBasicMaterial color="#ff5a5a" depthTest={false} transparent opacity={0.95} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
