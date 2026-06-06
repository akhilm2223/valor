import { Suspense, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Stats, Sky } from "@react-three/drei";
import { Arena, FitModel } from "./Models";
import { Scatter } from "./Scatter";
import { Gun } from "./Gun";

// All the Mixamo clips, playable on the in-map character. "" = static bind pose.
const ANIMATIONS = [
  { label: "Bind pose", url: "" },
  { label: "Aiming idle", url: "/animations/aiming_idle.glb" },
  { label: "Firing", url: "/animations/firing.glb" },
  { label: "Reloading", url: "/animations/reloading.glb" },
  { label: "Walking", url: "/animations/walking.glb" },
  { label: "Rifle run", url: "/animations/rifle_run.glb" },
  { label: "Strafe L", url: "/animations/strafe_left.glb" },
  { label: "Strafe R", url: "/animations/strafe_right.glb" },
  { label: "Crouch idle", url: "/animations/crouch_idle.glb" },
  { label: "Grab pistol", url: "/animations/grabbing.glb" },
  { label: "Punch", url: "/animations/punch.glb" },
  { label: "Dying", url: "/animations/dying.glb" },
];

// Character placed at an explicit position (driven by the Move buttons) so you can
// stand it exactly where you want and read off where the ground is.
function MapCharacter({ pos, animation = "" }: { pos: [number, number, number]; animation?: string }) {
  return (
    <group position={pos}>
      <FitModel url="/models/character_b.glb" height={1.8} hold={<Gun length={0.22} variant="normal" />} animation={animation} castShadow />
    </group>
  );
}

const btn = (active = false): React.CSSProperties => ({
  padding: "6px 9px",
  borderRadius: 7,
  border: "1px solid rgba(255,255,255,0.15)",
  background: active ? "#4f8cff" : "rgba(255,255,255,0.08)",
  color: "#fff",
  cursor: "pointer",
});

export function App() {
  const [anim, setAnim] = useState("");
  // Standing spot on the ground, dialed in via the Move buttons.
  const [pos, setPos] = useState<[number, number, number]>([12, -7, -9.5]);
  const [step, setStep] = useState(0.5); // metres per nudge

  const bump = (i: number, d: number) =>
    setPos((p) => p.map((v, j) => (j === i ? +(v + d).toFixed(2) : v)) as [number, number, number]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas shadows camera={{ position: [4, 2.6, 6.5], fov: 50, near: 0.1, far: 2000 }} dpr={[1, 2]}>
        {/* Solid sky-blue background so the edges never show white canvas */}
        <color attach="background" args={["#bcd4e6"]} />
        {/* Distance fog blends the ground into that same blue at the horizon */}
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
          {/* Rocks to fill the bare ground around the town */}
          <Scatter />
          {/* Character placed by the Move buttons */}
          <MapCharacter pos={pos} animation={anim} />
          {/* Image-based lighting for material reflections, but no visible background */}
          <Environment preset="sunset" />
        </Suspense>

        {/* Free roam: left-drag orbit, right-drag pan, wheel zoom (0.5–200) */}
        <OrbitControls makeDefault target={[0, 1, 0]} enablePan minDistance={0.5} maxDistance={200} maxPolarAngle={Math.PI * 0.95} panSpeed={1.2} />
        <Stats />
      </Canvas>

      {/* Jump to the playable FPS (PASS 1). */}
      <a
        href="?game"
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          color: "#fff",
          font: "600 14px system-ui, sans-serif",
          textDecoration: "none",
          background: "#3a7bff",
          padding: "9px 14px",
          borderRadius: 9,
          boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
        }}
      >
        ▶ Play Game
      </a>

      {/* Control panel — move the model + play any clip */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          padding: "12px 14px",
          background: "rgba(20,24,28,0.82)",
          color: "#fff",
          borderRadius: 10,
          font: "13px/1.4 system-ui, sans-serif",
          backdropFilter: "blur(6px)",
          userSelect: "none",
          width: 230,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>🗺️ Arena</div>

        {/* MOVE MODEL */}
        <div style={{ fontWeight: 600, marginBottom: 6, opacity: 0.9 }}>Move model</div>
        {(["X", "Y (up/down)", "Z"] as const).map((label, i) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
            <span style={{ width: 70, opacity: 0.8, fontSize: 12 }}>{label}</span>
            <button style={btn()} onClick={() => bump(i, -step)}>−</button>
            <span style={{ flex: 1, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{pos[i].toFixed(2)}</span>
            <button style={btn()} onClick={() => bump(i, step)}>+</button>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <span style={{ width: 70, opacity: 0.8, fontSize: 12 }}>Step</span>
          {[0.25, 0.5, 2, 5].map((s) => (
            <button key={s} style={{ ...btn(step === s), padding: "4px 7px" }} onClick={() => setStep(s)}>
              {s}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6, wordBreak: "break-all" }}>
          pos [{pos.map((v) => v.toFixed(2)).join(", ")}]
        </div>
        <button style={{ ...btn(), width: "100%", marginTop: 6 }} onClick={() => setPos([12, -7, -9.5])}>
          Reset position
        </button>

        {/* ANIMATIONS */}
        <div style={{ fontWeight: 600, margin: "14px 0 6px", opacity: 0.9 }}>Animation</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ANIMATIONS.map((a) => (
            <button key={a.url || "bind"} onClick={() => setAnim(a.url)} style={{ ...btn(anim === a.url), flex: "0 0 auto" }}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
