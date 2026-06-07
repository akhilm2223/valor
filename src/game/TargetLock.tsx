// ─────────────────────────────────────────────────────────────────────────
// TargetLock.tsx — the on-screen aim-assist indicator + the lock driver.
//
// Every frame it recomputes the aim lock from the camera (updateLock) and draws
// a red ring on the locked enemy so you can SEE what the next shot will hit (and
// turn to switch). Rendered on top (depthTest off, high renderOrder) so cover
// never hides it. Weapon.fire() reads the same getLock().
// ─────────────────────────────────────────────────────────────────────────

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { type Group, Vector3 } from "three";
import { updateLock, getLock } from "./aimAssist";

export function TargetLock() {
  const camera = useThree((s) => s.camera);
  const ref = useRef<Group>(null);
  const o = useRef(new Vector3());
  const d = useRef(new Vector3());

  useFrame(() => {
    camera.getWorldPosition(o.current);
    camera.getWorldDirection(d.current).normalize();
    updateLock(
      [o.current.x, o.current.y, o.current.z],
      [d.current.x, d.current.y, d.current.z],
    );
    const g = ref.current;
    if (!g) return;
    const lock = getLock();
    if (lock) {
      g.visible = true;
      // A touch above the capsule centre ≈ upper chest/head.
      g.position.set(lock.point[0], lock.point[1] + 0.35, lock.point[2]);
      g.quaternion.copy(camera.quaternion); // billboard toward the camera
    } else {
      g.visible = false;
    }
  });

  return (
    <group ref={ref} visible={false} renderOrder={999}>
      {/* Ring */}
      <mesh>
        <torusGeometry args={[0.5, 0.035, 8, 40]} />
        <meshBasicMaterial color="#ff5a5a" depthTest={false} transparent opacity={0.95} toneMapped={false} />
      </mesh>
      {/* Four corner ticks for a "locked bracket" read */}
      {[0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => (
        <mesh key={a} position={[Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0]} rotation={[0, 0, a]}>
          <boxGeometry args={[0.16, 0.05, 0.001]} />
          <meshBasicMaterial color="#ff5a5a" depthTest={false} transparent opacity={0.95} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
