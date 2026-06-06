import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Stats, Sky } from "@react-three/drei";
import { Arena } from "./Models";
import { Scatter } from "./Scatter";

export function App() {
  return (
    <Canvas
      shadows
      camera={{ position: [16, 11, 16], fov: 50, near: 0.1, far: 2000 }}
      dpr={[1, 2]}
    >
      {/* Distance fog hides the endless flat ground plane fading into a blown-out horizon */}
      <fog attach="fog" args={["#bcd4e6", 45, 120]} />

      {/* Daytime blue sky + sun. Lower sun + higher rayleigh = blue, not white-washed */}
      <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
      <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
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
        {/* Trees + rocks to fill the bare ground around the town */}
        <Scatter />
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
