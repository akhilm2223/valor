import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, Stats, Sky, useGLTF } from "@react-three/drei";
import { Group, Vector3, Mesh } from "three";
import { FitModel } from "../Models";
import { Gun } from "../Gun";
import { useKeys } from "./useKeys";
import { Bullets, spawnBullet } from "./Bullets";

// The actual game: drive a character around the arena_opt map and shoot. Separate
// from the studio (5155 "/") — this is "/#game". Keyboard for now (WASD move, click
// fire, R reload, C crouch); the same inputs later come from MediaPipe / the network.

const SPAWN: [number, number, number] = [0, 0, 6];
const MOVE_SPEED = 3.6; // m/s
const CHAR = "/models/character_b.glb";

// movement/action state -> which clip FitModel plays
const CLIP: Record<string, string> = {
  idle: "/animations/aiming_idle.glb",
  walk: "/animations/walking.glb",
  strafeL: "/animations/strafe_left.glb",
  strafeR: "/animations/strafe_right.glb",
  fire: "/animations/firing.glb",
  reload: "/animations/reloading.glb",
  crouch: "/animations/crouch_idle.glb",
};

// The full Chicken Gun town map (24 MB original, not the carved studio plaza).
function GameArena() {
  const { scene } = useGLTF("/models/arena_chickengun.glb");
  return <primitive object={scene} />;
}
useGLTF.preload("/models/arena_chickengun.glb");

function Player() {
  const keys = useKeys();
  const { camera, gl } = useThree();
  const controls = useThree((s) => s.controls) as { target: Vector3 } | null;

  const rig = useRef<Group>(null!); // moved + rotated each frame
  const [clip, setClip] = useState(CLIP.idle);
  const stateRef = useRef("idle");
  const fireTimer = useRef(0);
  const reloadTimer = useRef(0);
  const wantFire = useRef(false);

  // scratch vectors
  const fwd = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  const move = useMemo(() => new Vector3(), []);
  const up = useMemo(() => new Vector3(0, 1, 0), []);
  const muzzle = useMemo(() => new Vector3(), []);

  // left-click on the canvas = fire (a drag still orbits via OrbitControls)
  useEffect(() => {
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) wantFire.current = true;
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [gl]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const k = keys.current;

    // camera-relative basis (flatten pitch)
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.crossVectors(fwd, up).normalize();

    // WASD -> world move vector
    const f = (k["KeyW"] ? 1 : 0) - (k["KeyS"] ? 1 : 0);
    const s = (k["KeyD"] ? 1 : 0) - (k["KeyA"] ? 1 : 0);
    move.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
    const moving = move.lengthSq() > 0;
    if (moving) move.normalize();

    // advance position + face the camera-forward direction
    rig.current.position.addScaledVector(move, MOVE_SPEED * dt);
    rig.current.position.y = SPAWN[1];
    rig.current.rotation.y = Math.atan2(fwd.x, fwd.z) + Math.PI; // character forward is -Z

    // fire request -> spawn a bullet from the muzzle along the aim
    if (fireTimer.current > 0) fireTimer.current -= dt;
    if (reloadTimer.current > 0) reloadTimer.current -= dt;
    if (k["KeyR"] && reloadTimer.current <= 0) reloadTimer.current = 0.7;
    if (wantFire.current) {
      wantFire.current = false;
      if (reloadTimer.current <= 0) {
        muzzle.copy(rig.current.position).addScaledVector(up, 1.35).addScaledVector(fwd, 0.5);
        spawnBullet(muzzle, fwd);
        fireTimer.current = 0.35;
      }
    }

    // resolve animation state (priority: fire > reload > crouch > strafe > walk > idle)
    let next = "idle";
    if (fireTimer.current > 0) next = "fire";
    else if (reloadTimer.current > 0) next = "reload";
    else if (k["KeyC"]) next = "crouch";
    else if (moving && Math.abs(s) > Math.abs(f)) next = s > 0 ? "strafeR" : "strafeL";
    else if (moving) next = "walk";
    if (next !== stateRef.current) {
      stateRef.current = next;
      setClip(CLIP[next]);
    }

    // follow-cam: keep OrbitControls focused on the player (orbit to look around)
    if (controls) controls.target.lerp(muzzle.copy(rig.current.position).addScaledVector(up, 1.2), 0.25);
  });

  return (
    <group ref={rig} position={SPAWN}>
      <FitModel url={CHAR} height={1.8} hold={<Gun length={0.22} variant="normal" />} animation={clip} castShadow />
    </group>
  );
}

function Scene() {
  const arena = useRef<Group>(null!);

  // build BVH on the arena meshes for fast bullet raycasts
  useEffect(() => {
    arena.current?.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) (m.geometry as any).computeBoundsTree?.();
    });
  }, []);

  return (
    <>
      {/* Clean daytime map look (matches the original arena scene): sky-blue bg +
          distance fog blending to the horizon + sun, so the town reads cleanly. */}
      <color attach="background" args={["#bcd4e6"]} />
      <fog attach="fog" args={["#bcd4e6", 60, 220]} />
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
        <group ref={arena}>
          <GameArena />
        </group>
        <Player />
        <Bullets colliders={arena} />
        <Environment preset="sunset" />
      </Suspense>
      <OrbitControls makeDefault minDistance={2} maxDistance={40} maxPolarAngle={Math.PI / 2.1} />
      <Stats />
    </>
  );
}

export function GameView() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas shadows camera={{ position: [0, 3, 12], fov: 55, near: 0.1, far: 300 }} dpr={[1, 2]}>
        <Scene />
      </Canvas>

      {/* crosshair */}
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
          boxShadow: "0 0 0 2px rgba(0,0,0,0.4)",
          pointerEvents: "none",
        }}
      />

      {/* controls hint + back to studio */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          padding: "10px 12px",
          background: "rgba(20,24,28,0.82)",
          color: "#fff",
          borderRadius: 10,
          font: "13px/1.5 system-ui, sans-serif",
          backdropFilter: "blur(6px)",
          userSelect: "none",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>🎮 MOSH — arena</div>
        <div style={{ opacity: 0.85 }}>WASD move · drag orbit · click fire · R reload · C crouch</div>
        <a href="#" style={{ color: "#7db0ff", display: "inline-block", marginTop: 8 }}>
          ← Back to studio
        </a>
      </div>
    </div>
  );
}
