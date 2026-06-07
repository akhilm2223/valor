// Lobby — the landing screen at `/`. Replaces the Model Studio as the front
// door (the studio still lives at `#studio`). Three jobs:
//   1. Pick a character model (live 3D turntable preview).
//   2. Copy an invite link to send to friends so they join the same match.
//   3. Enter a name + Play → navigates to `#multiplayer`.
//
// Selection is persisted to localStorage (name + model). MultiplayerGame reads
// both: the name pre-fills its Join prompt, the model drives the local rig.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import type { Group } from "three";
import { FitModel } from "../Models";
import { Gun } from "../Gun";
import { MODELS } from "../net/playerModel";

const NAME_KEY = "valor.player.name";
const MODEL_KEY = "valor.player.model";
const IDLE = "/animations/aiming_idle.glb";

// Frame the camera on the character's torso (model is 1.8m tall, feet at y=0).
// The Canvas camera prop only sets position, not a look target — default lookAt
// is the origin (the feet), which is why an unframed preview shows only legs.
function PreviewRig() {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(0, 1.05, 3.7);
    camera.lookAt(0, 0.95, 0);
  }, [camera]);
  return null;
}

// Slowly spinning character on a pedestal so the pick reads in 3D.
function Turntable({ url }: { url: string }) {
  const ref = useRef<Group>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.6;
  });
  return (
    <group ref={ref}>
      <FitModel url={url} height={1.8} hold={<Gun length={0.22} variant="normal" />} animation={IDLE} castShadow />
    </group>
  );
}

export function Lobby() {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [modelKey, setModelKey] = useState(() => {
    try {
      const saved = localStorage.getItem(MODEL_KEY);
      return MODELS.find((c) => c.url === saved)?.key ?? MODELS[0].key;
    } catch {
      return MODELS[0].key;
    }
  });
  const [copied, setCopied] = useState(false);

  const selected = useMemo(
    () => MODELS.find((c) => c.key === modelKey) ?? MODELS[0],
    [modelKey],
  );

  const inviteLink = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/#multiplayer`;
  }, []);

  const persist = () => {
    try {
      localStorage.setItem(NAME_KEY, name.trim().slice(0, 16));
      localStorage.setItem(MODEL_KEY, selected.url);
    } catch {
      /* private mode — ignore */
    }
  };

  const copyLink = async () => {
    persist();
    try {
      await navigator.clipboard.writeText(inviteLink);
    } catch {
      /* clipboard blocked — the link is shown below to copy manually */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const play = () => {
    persist();
    window.location.hash = "#multiplayer";
  };

  const canPlay = name.trim().length > 0;

  return (
    <div style={page}>
      {/* Left — live character preview */}
      <div style={previewWrap}>
        <Canvas shadows camera={{ position: [0, 1.05, 3.7], fov: 42 }} dpr={[1, 2]}>
          <color attach="background" args={["#0e1320"]} />
          <PreviewRig />
          <ambientLight intensity={0.7} />
          <directionalLight position={[4, 8, 6]} intensity={2.2} castShadow />
          <Suspense fallback={null}>
            <Turntable url={selected.url} />
            <Environment preset="city" />
          </Suspense>
          {/* soft ground disc */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
            <circleGeometry args={[1.4, 48]} />
            <meshStandardMaterial color="#161d2e" />
          </mesh>
        </Canvas>
        <div style={previewTag}>{selected.label}</div>
      </div>

      {/* Right — controls */}
      <div style={panel}>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 0.5 }}>VALOR</div>
        <div style={{ opacity: 0.6, fontSize: 13, marginBottom: 22 }}>
          Body-controlled 1v1v1 — pick a fighter, share the link, play.
        </div>

        <label style={fieldLabel}>YOUR NAME</label>
        <input
          value={name}
          autoFocus
          maxLength={16}
          placeholder="Enter a name"
          onChange={(e) => setName(e.target.value)}
          style={input}
        />

        <label style={{ ...fieldLabel, marginTop: 20 }}>CHARACTER</label>
        <div style={{ display: "flex", gap: 10 }}>
          {MODELS.map((c) => {
            const on = c.key === modelKey;
            return (
              <button
                key={c.key}
                onClick={() => setModelKey(c.key)}
                style={{
                  ...charBtn,
                  border: on ? "2px solid #3a7bff" : "2px solid rgba(255,255,255,0.12)",
                  background: on ? "rgba(58,123,255,0.18)" : "rgba(255,255,255,0.04)",
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <label style={{ ...fieldLabel, marginTop: 22 }}>INVITE FRIENDS</label>
        <button onClick={copyLink} style={inviteBtn}>
          {copied ? "✓ Link copied — send it!" : "🔗 Copy invite link"}
        </button>
        <div style={linkText}>{inviteLink}</div>
        <div style={{ opacity: 0.45, fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
          Same Wi-Fi? Open this page via the terminal's <b>Network</b> URL first, then copy —
          the link will point at your LAN address so friends can reach it.
        </div>

        <button
          onClick={play}
          disabled={!canPlay}
          style={{
            ...playBtn,
            background: canPlay ? "#3a7bff" : "#2a2f37",
            cursor: canPlay ? "pointer" : "not-allowed",
          }}
        >
          ▶ Play
        </button>

        <a href="#studio" style={studioLink}>
          open animation studio →
        </a>
      </div>
    </div>
  );
}

// ---- styles --------------------------------------------------------------

const page: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  background: "#0a0d14",
  color: "#fff",
  fontFamily: "system-ui, sans-serif",
};

const previewWrap: React.CSSProperties = {
  position: "relative",
  flex: "1 1 0",
  minWidth: 0,
  borderRight: "1px solid rgba(255,255,255,0.07)",
};

const previewTag: React.CSSProperties = {
  position: "absolute",
  bottom: 18,
  left: 18,
  padding: "6px 12px",
  background: "rgba(20,24,28,0.7)",
  borderRadius: 8,
  fontWeight: 700,
  letterSpacing: 1,
};

const panel: React.CSSProperties = {
  width: 380,
  flexShrink: 0,
  padding: "44px 34px",
  display: "flex",
  flexDirection: "column",
  background: "#0e1320",
};

const fieldLabel: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1,
  opacity: 0.6,
  fontWeight: 700,
  marginBottom: 7,
};

const input: React.CSSProperties = {
  padding: "11px 13px",
  fontSize: 16,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(0,0,0,0.4)",
  color: "#fff",
  borderRadius: 9,
  boxSizing: "border-box",
};

const charBtn: React.CSSProperties = {
  flex: 1,
  padding: "12px 0",
  fontSize: 14,
  fontWeight: 600,
  color: "#fff",
  borderRadius: 10,
  cursor: "pointer",
};

const inviteBtn: React.CSSProperties = {
  padding: "11px 14px",
  fontSize: 14,
  fontWeight: 600,
  color: "#fff",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 9,
  cursor: "pointer",
};

const linkText: React.CSSProperties = {
  marginTop: 8,
  padding: "7px 10px",
  fontSize: 11,
  fontFamily: "ui-monospace, monospace",
  color: "#9cc0ff",
  background: "rgba(0,0,0,0.35)",
  borderRadius: 7,
  wordBreak: "break-all",
};

const playBtn: React.CSSProperties = {
  marginTop: 26,
  padding: "15px 14px",
  fontSize: 17,
  fontWeight: 800,
  letterSpacing: 1,
  color: "#fff",
  border: "none",
  borderRadius: 11,
};

const studioLink: React.CSSProperties = {
  marginTop: 18,
  fontSize: 12,
  color: "#6f7c93",
  textDecoration: "none",
  textAlign: "center",
};
