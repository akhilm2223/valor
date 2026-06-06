import { useMemo } from "react";

// A procedural semi-auto pistol built from primitives — no model file needed.
// Modeled barrel-forward along -Z, grip down -Y, so when parented to a hand bone
// (or placed in front of an FPP camera) the muzzle points the way you look.
// `length` scales the whole gun in world units (slide is ~`length` long).
export function Gun({ length = 0.22, ...props }: { length?: number } & React.ComponentProps<"group">) {
  // Derive every part from `length` so the proportions hold at any scale.
  const d = useMemo(() => {
    const L = length;
    return {
      slideLen: L,
      slideH: L * 0.28,
      slideW: L * 0.22,
      barrelLen: L * 0.45,
      gripLen: L * 0.75,
      gripW: L * 0.2,
      gripThick: L * 0.26,
      triggerGuard: L * 0.18,
    };
  }, [length]);

  const metal = { color: "#23262b", metalness: 0.85, roughness: 0.35 };
  const grip = { color: "#15171a", metalness: 0.2, roughness: 0.8 };

  return (
    <group {...props}>
      {/* Slide / upper receiver — the long top block, barrel pointing -Z */}
      <mesh position={[0, 0, -d.slideLen * 0.1]} castShadow>
        <boxGeometry args={[d.slideW, d.slideH, d.slideLen]} />
        <meshStandardMaterial {...metal} />
      </mesh>

      {/* Barrel muzzle poking out the front */}
      <mesh position={[0, d.slideH * 0.05, -d.slideLen * 0.6 - d.barrelLen / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[d.slideW * 0.32, d.slideW * 0.32, d.barrelLen, 16]} />
        <meshStandardMaterial {...metal} />
      </mesh>

      {/* Front sight */}
      <mesh position={[0, d.slideH * 0.6, -d.slideLen * 0.5]} castShadow>
        <boxGeometry args={[d.slideW * 0.18, d.slideH * 0.4, d.slideW * 0.2]} />
        <meshStandardMaterial {...metal} />
      </mesh>
      {/* Rear sight */}
      <mesh position={[0, d.slideH * 0.6, d.slideLen * 0.42]} castShadow>
        <boxGeometry args={[d.slideW * 0.5, d.slideH * 0.35, d.slideW * 0.2]} />
        <meshStandardMaterial {...metal} />
      </mesh>

      {/* Grip — angled back and down, the part the hand wraps */}
      <mesh position={[0, -d.gripLen * 0.45, d.slideLen * 0.28]} rotation={[0.32, 0, 0]} castShadow>
        <boxGeometry args={[d.gripW, d.gripLen, d.gripThick]} />
        <meshStandardMaterial {...grip} />
      </mesh>

      {/* Trigger guard — a small ring under the receiver */}
      <mesh position={[0, -d.slideH * 0.9, d.slideLen * 0.05]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[d.triggerGuard, d.slideW * 0.08, 8, 16]} />
        <meshStandardMaterial {...metal} />
      </mesh>

      {/* Trigger */}
      <mesh position={[0, -d.slideH * 0.9, d.slideLen * 0.05]} castShadow>
        <boxGeometry args={[d.slideW * 0.12, d.triggerGuard * 0.9, d.slideW * 0.1]} />
        <meshStandardMaterial {...metal} />
      </mesh>
    </group>
  );
}
