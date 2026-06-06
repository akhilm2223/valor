import { useGLTF } from "@react-three/drei";

// The Chicken Gun map, optimized to 3.5 MB (WebP textures @ 512px + Draco).
// Source 24 MB original kept at arena_chickengun.glb for reference.
// Re-optimize: see README.md "Optimizing the arena".
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
