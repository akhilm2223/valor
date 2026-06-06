import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Stats, Sky } from "@react-three/drei";
import { Arena } from "./Models";

export function App() {
  return (
    <Canvas
      shadows
      camera={{ position: [16, 11, 16], fov: 50, near: 0.1, far: 2000 }}
      dpr={[1, 2]}
    >
      {/* Daytime sky + sun so the town reads clearly instead of the washed-out city HDRI */}
      <Sky sunPosition={[40, 30, 20]} turbidity={6} rayleigh={1.5} />
      <hemisphereLight args={["#cfe8ff", "#5a4633", 0.7]} />
      <directionalLight
        position={[40, 50, 20]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-bias={-0.0004}
      />

      <Suspense fallback={null}>
        <Arena />
        {/* Image-based lighting for material reflections, but no visible background */}
        <Environment preset="sunset" />
      </Suspense>

      {/* Framed on the building cluster (the ground plane is huge; don't auto-fit to it) */}
      <OrbitControls
        makeDefault
        target={[0, 2, 0]}
        minDistance={8}
        maxDistance={60}
        maxPolarAngle={Math.PI / 2.1}
      />
      <Stats />
    </Canvas>
  );
}
