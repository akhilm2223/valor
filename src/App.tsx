import { Suspense, useState, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Stats, Grid, ContactShadows, PerspectiveCamera } from "@react-three/drei";
import { FitModel } from "./Models";
import { Gun, type GunVariant } from "./Gun";

// 5155 is the TEST STUDIO — a clean stage for previewing characters, the gun, and
// (next) Mixamo animations before they go into the real game. No arena map here:
// just a neutral floor + grid so models read clearly and we can judge scale/pose.
// The actual game world (arena_chickengun / arena_opt) lives in the game build.

type View = "orbit" | "fpp";

const MODELS = [
  { label: "Character B", url: "/models/character_b.glb" },
  { label: "Character A", url: "/models/character_a.glb" },
  { label: "Clay", url: "/models/clay.glb" },
];

// Slim Shooter Pack — Mixamo clips played on the rig (see ClipPlayer). Converted
// from FBX to GLB via Blender. "" = static bind pose. Files in /public/animations.
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

// Gun-in-hand transforms, dialed in via the studio's Fix Gun panel then baked here.
// Offset in metres, rotation in radians, scale multiplies the auto hand-scale,
// curl wraps the fingers. There are TWO presets because the animations rotate the
// hand bone away from its bind orientation, so the gun needs a different offset to
// sit in the grip while a clip plays vs. the static bind pose.
const GUN_HOLD_STATIC = {
  offset: [0, 0.08, -0.02] as [number, number, number],
  rotation: [(-172 * Math.PI) / 180, -Math.PI / 2, -Math.PI / 2] as [number, number, number],
  scale: 1.2,
  curl: 1,
};
const GUN_HOLD_ANIM = {
  offset: [0.04, 0.24, -0.02] as [number, number, number],
  rotation: [(-277 * Math.PI) / 180, (15 * Math.PI) / 180, (-75 * Math.PI) / 180] as [number, number, number],
  scale: 1.2,
  curl: 1,
};

export function App() {
  const [url, setUrl] = useState(MODELS[0].url);
  const [height, setHeight] = useState(1.8); // ~human height in metres
  const [view, setView] = useState<View>("orbit");
  const [gun, setGun] = useState(true);
  const [gunVariant, setGunVariant] = useState<GunVariant>("normal");
  const [anim, setAnim] = useState(""); // "" = bind pose; else an /animations/*.fbx url

  // Gun-in-hand transform (the "fix the gun" controls). Tuned live in the panel,
  // then the numbers were read off and baked into GUN_HOLD as the defaults.
  const [gOff, setGOff] = useState<[number, number, number]>(GUN_HOLD_STATIC.offset);
  const [gRot, setGRot] = useState<[number, number, number]>(GUN_HOLD_STATIC.rotation);
  const [gScale, setGScale] = useState(GUN_HOLD_STATIC.scale);
  const [curl, setCurl] = useState(GUN_HOLD_STATIC.curl); // finger curl around the grip, 0..1

  // Swap the gun-hold preset when a clip starts/stops: bind pose and animation
  // need different offsets for the gun to sit in the grip (the clip rotates the
  // hand bone). Re-applies the preset on every toggle, so manual nudges reset.
  const animating = anim !== "";
  useEffect(() => {
    const h = animating ? GUN_HOLD_ANIM : GUN_HOLD_STATIC;
    setGOff(h.offset);
    setGRot(h.rotation);
    setGScale(h.scale);
    setCurl(h.curl);
  }, [animating]);
  const POS_STEP = 0.02; // metres per nudge
  const ROT_STEP = Math.PI / 24; // 7.5° per nudge
  const bump = (set: typeof setGOff, i: number, d: number) =>
    set((v) => v.map((x, j) => (j === i ? x + d : x)) as [number, number, number]);

  const eye = height * 0.92; // FPP camera at ~eye level of the standing character

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas shadows camera={{ position: [2.6, 1.8, 3.2], fov: 45, near: 0.05, far: 100 }} dpr={[1, 2]}>
        {/* Neutral studio backdrop */}
        <color attach="background" args={["#2a2d33"]} />

        {/* Soft three-point-ish lighting for a clean model-viewer look */}
        <hemisphereLight args={["#ffffff", "#3a3a40", 1.1]} />
        <directionalLight
          position={[4, 6, 3]}
          intensity={2.4}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-4}
          shadow-camera-right={4}
          shadow-camera-top={4}
          shadow-camera-bottom={-4}
          shadow-bias={-0.0004}
        />
        <directionalLight position={[-5, 3, -4]} intensity={0.6} />

        <Suspense fallback={null}>
          {/* Character centered at origin, feet on the floor, holding the gun. */}
          {view !== "fpp" && (
            <FitModel
              url={url}
              height={height}
              position={[0, 0, 0]}
              hold={gun ? <Gun length={0.22} variant={gunVariant} /> : undefined}
              holdOffset={gOff}
              holdRotation={gRot}
              holdScale={gScale}
              gripCurl={curl}
              animation={anim}
              castShadow
            />
          )}
          <Environment preset="city" />
        </Suspense>

        {/* Studio floor: contact shadow grounds the model, grid gives scale reference */}
        <ContactShadows position={[0, 0.001, 0]} opacity={0.5} scale={12} blur={2.2} far={6} />
        <Grid
          position={[0, 0, 0]}
          args={[20, 20]}
          cellSize={0.5}
          cellThickness={0.6}
          cellColor="#454852"
          sectionSize={2.5}
          sectionThickness={1.1}
          sectionColor="#5c8cff"
          fadeDistance={22}
          fadeStrength={1}
          infiniteGrid
        />

        {view === "fpp" ? (
          <>
            <PerspectiveCamera makeDefault position={[0, eye, 0]} fov={75} near={0.03} far={100} />
            <OrbitControls makeDefault target={[0, eye, 4]} enablePan={false} />
          </>
        ) : (
          // Orbit around the model — turntable for inspecting from any angle.
          <OrbitControls makeDefault target={[0, height * 0.5, 0]} minDistance={0.6} maxDistance={20} />
        )}
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

      {/* Studio control panel */}
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
          minWidth: 190,
          maxWidth: 230, // keep the animation-button row wrapping instead of widening the panel over the model
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10, letterSpacing: 0.3 }}>🎬 Model Studio</div>

        <div style={{ fontWeight: 600, marginBottom: 8, opacity: 0.9 }}>Camera</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {([["orbit", "Orbit"], ["fpp", "First-person"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={tab(view === v)}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ fontWeight: 600, marginBottom: 8, opacity: 0.9 }}>Model</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {MODELS.map((m) => (
            <button key={m.url} onClick={() => setUrl(m.url)} style={{ ...tab(url === m.url), textAlign: "left" }}>
              {m.label}
            </button>
          ))}
        </div>

        <div style={{ fontWeight: 600, margin: "14px 0 8px", opacity: 0.9 }}>Animation</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ANIMATIONS.map((a) => (
            <button
              key={a.url || "bind"}
              onClick={() => setAnim(a.url)}
              style={{ ...tab(anim === a.url), flex: "0 0 auto", padding: "6px 9px" }}
            >
              {a.label}
            </button>
          ))}
        </div>

        <button onClick={() => setGun((g) => !g)} style={{ ...tab(gun), marginTop: 12, width: "100%" }}>
          {gun ? "🔫 Gun: ON" : "Gun: OFF"}
        </button>

        {gun && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {(
              [
                ["normal", "Normal"],
                ["golden", "Golden"],
                ["blaster", "Blaster"],
              ] as const
            ).map(([v, label]) => (
              <button key={v} onClick={() => setGunVariant(v)} style={{ ...tab(gunVariant === v), flex: "0 0 auto", padding: "6px 10px" }}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Fix-the-gun controls: nudge the pistol's position/rotation/scale in the
            hand until it sits in the grip, then read the numbers off to bake in. */}
        {gun && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
            <div style={{ fontWeight: 600, marginBottom: 6, opacity: 0.9 }}>Fix Gun</div>

            <AxisRow label="Move" unit="m" vals={gOff} onMinus={(i) => bump(setGOff, i, -POS_STEP)} onPlus={(i) => bump(setGOff, i, POS_STEP)} />
            <AxisRow
              label="Rotate"
              unit="°"
              vals={gRot}
              deg
              onMinus={(i) => bump(setGRot, i, -ROT_STEP)}
              onPlus={(i) => bump(setGRot, i, ROT_STEP)}
            />

            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <span style={{ width: 46, opacity: 0.8 }}>Scale</span>
              <button style={mini} onClick={() => setGScale((s) => Math.max(0.1, +(s - 0.1).toFixed(2)))}>−</button>
              <span style={{ flex: 1, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{gScale.toFixed(2)}×</span>
              <button style={mini} onClick={() => setGScale((s) => +(s + 0.1).toFixed(2))}>+</button>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, marginBottom: 4 }}>
              <span style={{ opacity: 0.8 }}>Grip fingers</span>
              <span style={{ opacity: 0.6 }}>{Math.round(curl * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={curl}
              onChange={(e) => setCurl(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />

            <button
              style={{ ...tab(false), width: "100%", marginTop: 10 }}
              onClick={() => {
                const h = animating ? GUN_HOLD_ANIM : GUN_HOLD_STATIC;
                setGOff(h.offset);
                setGRot(h.rotation);
                setGScale(h.scale);
                setCurl(h.curl);
              }}
            >
              Reset gun
            </button>
            {/* Copy-ready values for baking into the code */}
            <div style={{ fontSize: 10, opacity: 0.55, marginTop: 8, lineHeight: 1.5, wordBreak: "break-all" }}>
              offset [{gOff.map((v) => v.toFixed(2)).join(", ")}]<br />
              rot [{gRot.map((v) => v.toFixed(3)).join(", ")}]<br />
              scale {gScale.toFixed(2)}
            </div>
          </div>
        )}

        <div style={{ marginTop: 14, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, opacity: 0.9 }}>Height</span>
          <span style={{ opacity: 0.7 }}>{height.toFixed(2)}m</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.05}
          value={height}
          onChange={(e) => setHeight(parseFloat(e.target.value))}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {[1.6, 1.8, 2.0].map((h) => (
            <button key={h} onClick={() => setHeight(h)} style={tab(height === h)}>
              {h}m
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Shared button style; highlighted when active.
function tab(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "7px 10px",
    borderRadius: 7,
    border: "1px solid rgba(255,255,255,0.15)",
    background: active ? "#4f8cff" : "rgba(255,255,255,0.08)",
    color: "#fff",
    cursor: "pointer",
  };
}

// Small square −/+ button used by the gun-fix axis rows.
const mini: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 5,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.08)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

// A label + three X/Y/Z stepper pairs. `deg` shows radians as degrees.
function AxisRow({
  label,
  unit,
  vals,
  deg,
  onMinus,
  onPlus,
}: {
  label: string;
  unit: string;
  vals: [number, number, number];
  deg?: boolean;
  onMinus: (i: number) => void;
  onPlus: (i: number) => void;
}) {
  const show = (v: number) => (deg ? Math.round((v * 180) / Math.PI) : +v.toFixed(2));
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ opacity: 0.8, marginBottom: 4 }}>
        {label} <span style={{ opacity: 0.5 }}>({unit})</span>
      </div>
      {(["X", "Y", "Z"] as const).map((axis, i) => (
        <div key={axis} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 14, opacity: 0.7 }}>{axis}</span>
          <button style={mini} onClick={() => onMinus(i)}>−</button>
          <span style={{ flex: 1, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{show(vals[i])}</span>
          <button style={mini} onClick={() => onPlus(i)}>+</button>
        </div>
      ))}
    </div>
  );
}
