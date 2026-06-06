import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Stats } from "@react-three/drei";
import { Arena } from "./Models";

export function App() {
  return (
    <Canvas
      shadows
      camera={{ position: [12, 8, 12], fov: 55 }}
      dpr={[1, 2]}
    >
      <color attach="background" args={["#0a0a0a"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 20, 10]} intensity={1.2} castShadow />

      <Suspense fallback={null}>
        <Arena />
        <Environment preset="city" />
      </Suspense>

      <OrbitControls />
      <Stats />
    </Canvas>
  );
}
