// ─────────────────────────────────────────────────────────────────────────
// GameScene.tsx — the wired playable scene (PASS 1).
//
// Mounts the full local FPS: Rapier physics world + arena (fixed trimesh
// collider, registered with the hitscan BVH), the first-person PlayerController
// camera, the Weapon (fire pipeline + viewmodel), patrolling shootable Bots,
// pooled VFX, keyboard/mouse InputController, and the DOM HUD overlay.
//
// Physics runs a FIXED timestep (1/60) so movement and the 5-shots-to-kill
// cadence are frame-rate independent. Click the canvas to lock the pointer and
// play; WASD move, mouse look, click to fire, R to reload, Ctrl/C crouch.
// The studio (character/gun/anim viewer) stays at the default route; `?game`
// loads this.
// ─────────────────────────────────────────────────────────────────────────

import { Suspense, useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Sky } from "@react-three/drei";
import { Physics, RigidBody } from "@react-three/rapier";
import type { Group } from "three";
import { Arena } from "../Models";
import { Scatter } from "../Scatter";
import { PlayerController } from "./PlayerController";
import { Weapon } from "./Weapon";
import { Bots } from "./Bot";
import { Vfx } from "./vfx";
import { HUD } from "./HUD";
import { InputController } from "./input";
import { registerWorld, clearWorld, raycastShot } from "./hitscan";
import { tickCombat, combat } from "./combat";
import { useGame, transforms } from "./stores";
import { LOCAL_ID } from "./contracts";
import { VisionController } from "./VisionController";

// Static world: trimesh collider around the carved arena, also registered with
// the hitscan BVH for bullet-vs-world tests. Registration runs after the GLB has
// mounted under our group (we're inside <Suspense>, so geometry is ready).
function World() {
  const ref = useRef<Group>(null);
  useEffect(() => {
    if (ref.current) registerWorld(ref.current);
    return () => clearWorld();
  }, []);
  return (
    <RigidBody type="fixed" colliders="trimesh">
      <group ref={ref}>
        <Arena />
      </group>
      <Scatter />
    </RigidBody>
  );
}

// Drives time-based combat (respawns) once per frame, scene-wide.
function CombatTicker() {
  useFrame(() => tickCombat(Date.now()));
  return null;
}

// Explicit render pass. The Weapon's recoil uses a positive-priority useFrame
// (priority 10), which switches R3F into MANUAL render mode and disables its
// automatic render (otherwise the canvas stays black). So we render the scene
// ourselves at the HIGHEST priority — after movement (physics step), all
// priority-0 updates, and the recoil offset have run for the frame.
function RenderPass() {
  useFrame(({ gl, scene, camera }) => gl.render(scene, camera), 1000);
  return null;
}

// Dev-only handle so an automated browser smoke test can exercise the REAL wired
// modules (raycast against the live scene, apply damage) — stripped from prod.
function DevHook() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __mosh?: unknown }).__mosh = { useGame, transforms, raycastShot, combat, LOCAL_ID, gl, scene, camera };
  }, [gl, scene, camera]);
  return null;
}

function Scene() {
  return (
    <>
      {/* Same look as the studio map: sky-blue bg + fog + sun */}
      <color attach="background" args={["#bcd4e6"]} />
      <fog attach="fog" args={["#bcd4e6", 60, 220]} />
      <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
      <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
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
      {/* Isolated Suspense: the env map loads from a CDN, so if it's slow/blocked
          it must NOT blank the whole playable scene (the lights below already
          light it). */}
      <Suspense fallback={null}>
        <Environment preset="city" />
      </Suspense>

      <Physics timeStep={1 / 60}>
        <World />
        {/* Spawn just above the measured plaza floor (feet ~-3.76) so the player
            settles instantly instead of free-falling several metres. */}
        {/* Spawn on the real plaza ground (~y -7, per the studio's dialed-in stand
            point), capsule centre a bit above so it settles instead of falling. */}
        <PlayerController spawn={[10, -6, -6]} />
        <Weapon />
        <Bots count={3} />
        <Vfx />
        <CombatTicker />
      </Physics>

      <InputController />
      <DevHook />
      <RenderPass />
    </>
  );
}

export function Game() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas shadows camera={{ position: [0, 1.5, 6], fov: 75, near: 0.05, far: 300 }} dpr={[1, 2]} gl={{ preserveDrawingBuffer: import.meta.env.DEV }}>
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>

      <HUD />
      <VisionController />

      <a
        href="?"
        style={{ position: "absolute", top: 12, left: 12, color: "#fff", font: "13px system-ui", textDecoration: "none", background: "rgba(20,24,28,0.7)", padding: "6px 10px", borderRadius: 8 }}
      >
        ← Studio
      </a>
    </div>
  );
}
