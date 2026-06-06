import { useGLTF } from "@react-three/drei";

// The Chicken Gun map, carved to one plaza in Blender then optimized: 1.6 MB,
// 85 draw calls (was 24 MB / 785). WebP@512 + Draco + BLEND->OPAQUE material audit.
// Source 24 MB original kept at arena_chickengun.glb. Re-carve: see README "Optimizing the arena".
export function Arena() {
  const { scene } = useGLTF("/models/arena_opt.glb");
  return <primitive object={scene} />;
}

// One of the 3 characters. Swap the path for character_b.glb / clay.glb.
export function Character({ url = "/models/character_a.glb", ...props }: { url?: string } & JSX.IntrinsicElements["group"]) {
  const { scene } = useGLTF(url);
  return (
    <group {...props}>
      <primitive object={scene.clone()} />
    </group>
  );
}

useGLTF.preload("/models/arena_opt.glb");
useGLTF.preload("/models/character_a.glb");
useGLTF.preload("/models/character_b.glb");
useGLTF.preload("/models/clay.glb");
