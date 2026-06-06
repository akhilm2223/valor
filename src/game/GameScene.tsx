// ─────────────────────────────────────────────────────────────────────────
// GameScene.tsx — the game shell. PHASE 0 mounts the physics world + arena
// (with a Rapier fixed trimesh collider) + a placeholder character so the build
// and asset pipeline are verifiable. PHASE 3 wires in PlayerController, Weapon,
// Bots, VFX and the real HUD (marked with TODO(phaseN) below).
//
// `Game` is the full-screen entry (Canvas + DOM HUD overlay). The arena/lighting
// mirror the studio's setup in src/App.tsx. Physics runs a FIXED timestep
// (1/60) so movement and the 5-shots-to-kill cadence are frame-rate independent
// and the smoke test is reproducible.
// ─────────────────────────────────────────────────────────────────────────

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, OrbitControls } from "@react-three/drei";
import { Physics, RigidBody } from "@react-three/rapier";
import { Arena } from "../Models";
import { Gun } from "../Gun";
import { AnimatedCharacter } from "./AnimatedCharacter";

// In-canvas scene contents. Children are added phase by phase.
function Scene() {
  return (
    <>
      <color attach="background" args={["#8fd3ff"]} />
      <hemisphereLight args={["#ffffff", "#3a3a40", 1.0]} />
      <directionalLight
        position={[12, 18, 8]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0004}
      />
      <Environment preset="city" />

      <Physics timeStep={1 / 60}>
        {/* Static world: trimesh collider around the carved arena mesh. */}
        <RigidBody type="fixed" colliders="trimesh">
          <Arena />
        </RigidBody>

        {/* Placeholder bot — exercises the fit + hold pipeline. Replaced by the
            real <Bot/> spawner in Phase 2/3. */}
        <AnimatedCharacter url="/models/character_a.glb" height={1.8} position={[0, 0, 0]} hold={<Gun length={0.22} variant="normal" />} animState="idle" />
      </Physics>

      {/* TODO(phase3): replace OrbitControls with PlayerController FPP camera +
          InputController; mount <Weapon/>, <Bot/> spawner, <Vfx/>. */}
      <OrbitControls makeDefault target={[0, 1, 0]} />
    </>
  );
}

export function Game() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas shadows camera={{ position: [4, 2.5, 6], fov: 70, near: 0.05, far: 300 }} dpr={[1, 2]}>
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>

      {/* DOM crosshair placeholder — replaced by <HUD/> in Phase 3. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 6,
          height: 6,
          marginLeft: -3,
          marginTop: -3,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.85)",
          pointerEvents: "none",
        }}
      />
      <a href="?" style={{ position: "absolute", top: 12, left: 12, color: "#fff", font: "13px system-ui", textDecoration: "none", background: "rgba(20,24,28,0.7)", padding: "6px 10px", borderRadius: 8 }}>
        ← Studio
      </a>
    </div>
  );
}
