// CasterCam — fixed-angle spectator overview.
//
// Standalone route at #spectator. Subscribes to the live `players`, `game_match`,
// `shots`, and `commentary` tables and renders:
//   • The arena (re-uses arena_opt.glb, same trick as GameView so we don't carve
//     a new mesh for the spectator route).
//   • Every alive player as a small capsule + name tag, positioned from their
//     server-side `position` and oriented from `aim_vector`.
//   • A kill-feed overlay (last 5 shots that confirmed a kill, with names).
//   • A match HUD (round number, scores, state, timer).
//   • A subtitle bar at the bottom showing the most recent Color commentary
//     entry from the `commentary` table.
//
// Read-only — does NOT call any reducer. Safe to leave open on a big screen
// without it affecting the game.

import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Sky, useGLTF, Text } from "@react-three/drei";
import { Group, Mesh } from "three";
import { useRef } from "react";
import {
  connectValor,
  type ValorConnection,
  type Player,
  type GameMatch,
  type Shot,
  type Commentary,
} from "../net/Connection";
import { stripTags } from "../net/playerModel";

// Fixed vantage. Same flavor as the in-game spectator cam but a bit higher so
// the whole arena reads from the big-screen view.
const VANTAGE: [number, number, number] = [0, 18, 18];
const LOOK_AT: [number, number, number] = [0, 0, 0];

// ---- Scene -------------------------------------------------------------

function Arena() {
  const { scene } = useGLTF("/models/arena_opt.glb");
  return <primitive object={scene} />;
}
useGLTF.preload("/models/arena_opt.glb");

// Lightweight player marker: capsule body + name floating above.
function PlayerMarker({ player }: { player: Player }) {
  const ref = useRef<Group>(null!);
  // Team A = blue, Team B = red. Dead = grey + dimmed.
  const color = !player.alive ? "#555" : player.team === 0 ? "#7db0ff" : "#ff8a6e";
  const opacity = player.alive ? 1 : 0.35;
  return (
    <group ref={ref} position={[player.position.x, player.position.y + 0.9, player.position.z]}>
      {/* Body — short capsule. */}
      <mesh castShadow>
        <capsuleGeometry args={[0.32, 0.9, 4, 12]} />
        <meshStandardMaterial color={color} transparent opacity={opacity} roughness={0.7} />
      </mesh>
      {/* Aim indicator — a tiny barrel sticking out of the chest along aim. */}
      {player.alive ? (
        <mesh
          position={[
            player.aimVector.x * 0.55,
            player.aimVector.y * 0.55,
            player.aimVector.z * 0.55,
          ]}
        >
          <boxGeometry args={[0.1, 0.1, 0.6]} />
          <meshStandardMaterial color="#fff" emissive={color} emissiveIntensity={0.4} />
        </mesh>
      ) : null}
      <Text
        position={[0, 1.0, 0]}
        fontSize={0.28}
        color={color}
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.015}
        outlineColor="#000"
      >
        {player.name}
      </Text>
    </group>
  );
}

export function SpectatorScene({ players }: { players: Player[] }) {
  const arena = useRef<Group>(null!);
  useEffect(() => {
    arena.current?.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) (m.geometry as any).computeBoundsTree?.();
    });
  }, []);

  return (
    <>
      <color attach="background" args={["#bcd4e6"]} />
      <fog attach="fog" args={["#bcd4e6", 80, 260]} />
      <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
      <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
      <directionalLight
        position={[40, 50, 20]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
      />
      <Suspense fallback={null}>
        <group ref={arena}>
          <Arena />
        </group>
        {players.map((p) => (
          <PlayerMarker key={p.id} player={p} />
        ))}
        <Environment preset="sunset" />
      </Suspense>
    </>
  );
}

// ---- Live table hooks ---------------------------------------------------

function usePlayers(conn: ValorConnection | null): Player[] {
  const [players, setPlayers] = useState<Player[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: Player[] = [];
      for (const p of conn.db.players.iter()) all.push(p);
      setPlayers(all);
    };
    refresh();
    const onAny = () => refresh();
    conn.db.players.onInsert(onAny);
    conn.db.players.onUpdate(onAny);
    conn.db.players.onDelete(onAny);
    return () => {
      conn.db.players.removeOnInsert(onAny);
      conn.db.players.removeOnUpdate(onAny);
      conn.db.players.removeOnDelete(onAny);
    };
  }, [conn]);
  return players;
}

function useMatch(conn: ValorConnection | null): GameMatch | null {
  const [match, setMatch] = useState<GameMatch | null>(null);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      let next: GameMatch | null = null;
      for (const m of conn.db.game_match.iter()) {
        next = m;
        break;
      }
      setMatch(next);
    };
    refresh();
    const onAny = () => refresh();
    conn.db.game_match.onInsert(onAny);
    conn.db.game_match.onUpdate(onAny);
    return () => {
      conn.db.game_match.removeOnInsert(onAny);
      conn.db.game_match.removeOnUpdate(onAny);
    };
  }, [conn]);
  return match;
}

// Last 5 kills (shots with a victim_id). Newest first.
function useKillFeed(conn: ValorConnection | null): Shot[] {
  const [kills, setKills] = useState<Shot[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: Shot[] = [];
      for (const s of conn.db.shots.iter()) {
        if (s.victimId !== undefined && s.victimId !== null) all.push(s);
      }
      all.sort((a, b) => {
        const ta = a.firedAt.toMillis();
        const tb = b.firedAt.toMillis();
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
      setKills(all.slice(0, 5));
    };
    refresh();
    const onAny = () => refresh();
    conn.db.shots.onInsert(onAny);
    return () => {
      conn.db.shots.removeOnInsert(onAny);
    };
  }, [conn]);
  return kills;
}

// Latest Color commentary line (subtitle bar at the bottom).
function useLatestColor(conn: ValorConnection | null): Commentary | null {
  const [latest, setLatest] = useState<Commentary | null>(null);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      let best: Commentary | null = null;
      let bestMs: number | null = null;
      for (const c of conn.db.commentary.iter()) {
        if (c.kind.tag !== "Color") continue;
        const ms = Number(c.createdAt.toMillis());
        if (bestMs === null || ms > bestMs) {
          best = c;
          bestMs = ms;
        }
      }
      setLatest(best);
    };
    refresh();
    const onAny = () => refresh();
    conn.db.commentary.onInsert(onAny);
    return () => {
      conn.db.commentary.removeOnInsert(onAny);
    };
  }, [conn]);
  return latest;
}

// ---- DOM overlays -------------------------------------------------------

function MatchHud({ match }: { match: GameMatch | null }) {
  if (!match) {
    return (
      <div style={hudStyle}>
        <div style={hudLabel}>WAITING</div>
        <div style={{ fontSize: 14, opacity: 0.7 }}>No match yet</div>
      </div>
    );
  }
  return (
    <div style={hudStyle}>
      <div style={hudLabel}>ROUND {match.round} · {match.state.tag.toUpperCase()}</div>
      <div style={{ display: "flex", gap: 24, alignItems: "baseline", marginTop: 4 }}>
        <div>
          <span style={{ color: "#7db0ff", fontWeight: 700, fontSize: 22 }}>{match.scoreA}</span>
          <span style={{ opacity: 0.5, margin: "0 8px" }}>vs</span>
          <span style={{ color: "#ff8a6e", fontWeight: 700, fontSize: 22 }}>{match.scoreB}</span>
        </div>
        <div style={{ opacity: 0.65, fontSize: 13 }}>
          {Math.round(Number(match.roundTimerMs) / 1000)}s left
        </div>
      </div>
    </div>
  );
}

function KillFeed({ kills, playersById }: { kills: Shot[]; playersById: Map<number, Player> }) {
  if (kills.length === 0) {
    return (
      <div style={feedStyle}>
        <div style={feedLabel}>KILL FEED</div>
        <div style={{ opacity: 0.5, fontSize: 13 }}>No kills yet</div>
      </div>
    );
  }
  return (
    <div style={feedStyle}>
      <div style={feedLabel}>KILL FEED</div>
      {kills.map((s) => {
        const killer = playersById.get(s.shooterId);
        const victim = s.victimId !== undefined ? playersById.get(s.victimId) : undefined;
        const killerName = killer?.name ?? `P${s.shooterId}`;
        const victimName = victim?.name ?? (s.victimId !== undefined ? `P${s.victimId}` : "?");
        const killerColor = killer?.team === 0 ? "#7db0ff" : "#ff8a6e";
        const victimColor = victim?.team === 0 ? "#7db0ff" : "#ff8a6e";
        return (
          <div key={String(s.id)} style={{ fontSize: 13, padding: "3px 0" }}>
            <span style={{ color: killerColor, fontWeight: 600 }}>{killerName}</span>
            <span style={{ opacity: 0.6, margin: "0 6px" }}>→</span>
            <span style={{ color: victimColor, fontWeight: 600 }}>{victimName}</span>
          </div>
        );
      })}
    </div>
  );
}

function CommentaryBar({ commentary }: { commentary: Commentary | null }) {
  if (!commentary) return null;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: 720,
        padding: "12px 18px",
        background: "rgba(20,24,28,0.86)",
        color: "#fff",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.08)",
        font: "italic 500 16px/1.4 'Georgia', system-ui, sans-serif",
        textAlign: "center",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        pointerEvents: "none",
        userSelect: "none",
        boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
      }}
    >
      <span style={{ opacity: 0.7, marginRight: 8, fontStyle: "normal", fontSize: 11, letterSpacing: 0.7 }}>
        COMMENTARY
      </span>
      {stripTags(commentary.text)}
    </div>
  );
}

const hudStyle: React.CSSProperties = {
  position: "absolute",
  top: 18,
  left: 18,
  padding: "10px 14px",
  background: "rgba(20,24,28,0.82)",
  color: "#fff",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.08)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  font: "13px/1.3 system-ui, sans-serif",
  userSelect: "none",
  pointerEvents: "none",
};

const hudLabel: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.65,
  letterSpacing: 0.8,
  fontWeight: 600,
};

const feedStyle: React.CSSProperties = {
  position: "absolute",
  top: 18,
  right: 18,
  padding: "10px 14px",
  background: "rgba(20,24,28,0.82)",
  color: "#fff",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.08)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  font: "13px/1.3 system-ui, sans-serif",
  minWidth: 200,
  userSelect: "none",
  pointerEvents: "none",
};

const feedLabel: React.CSSProperties = {
  ...hudLabel,
  marginBottom: 6,
};

// ---- Public CasterCam component -----------------------------------------

export interface CasterCamProps {
  /**
   * Override the static vantage. Useful for the FreeFly variant to share the
   * scene + overlays but provide its own camera controls.
   */
  cameraPosition?: [number, number, number];
  /** Optional children injected into the R3F canvas (e.g. OrbitControls). */
  cameraExtras?: React.ReactNode;
  /** Footer hint string ("press T to toggle freefly" etc). */
  footerHint?: string;
}

export function CasterCam({ cameraPosition, cameraExtras, footerHint }: CasterCamProps = {}) {
  const [conn, setConn] = useState<ValorConnection | null>(null);
  const [status, setStatus] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = connectValor({
      onReady: () => setStatus("ready"),
      onError: (err) => {
        setStatus("error");
        setError(err.message ?? String(err));
      },
    });
    setConn(c);
    return () => {
      try {
        c.disconnect();
      } catch {
        /* noop */
      }
    };
  }, []);

  const players = usePlayers(conn);
  const match = useMatch(conn);
  const kills = useKillFeed(conn);
  const commentary = useLatestColor(conn);

  const playersById = useMemo(() => {
    const map = new Map<number, Player>();
    for (const p of players) map.set(p.id, p);
    return map;
  }, [players]);

  const camPos = cameraPosition ?? VANTAGE;

  return (
    <div style={{ position: "absolute", inset: 0, background: "#0e1115" }}>
      <Canvas shadows camera={{ position: camPos, fov: 50, near: 0.1, far: 400 }} dpr={[1, 2]}>
        <FixedLookAt target={LOOK_AT} />
        <SpectatorScene players={players} />
        {cameraExtras}
      </Canvas>

      <MatchHud match={match} />
      <KillFeed kills={kills} playersById={playersById} />
      <CommentaryBar commentary={commentary} />

      <div
        style={{
          position: "absolute",
          bottom: 18,
          left: 18,
          padding: "8px 12px",
          background: "rgba(20,24,28,0.82)",
          color: "#fff",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.08)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          font: "12px/1.4 system-ui, sans-serif",
          userSelect: "none",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 2 }}>SPECTATOR · CASTER CAM</div>
        <div style={{ opacity: 0.75 }}>
          {status === "connecting"
            ? "Connecting…"
            : status === "error"
              ? `Error: ${error}`
              : "Read-only · no writes to STDB"}
        </div>
        {footerHint ? (
          <div style={{ opacity: 0.6, marginTop: 4 }}>{footerHint}</div>
        ) : null}
        <a href="#" style={{ color: "#7db0ff", display: "inline-block", marginTop: 6 }}>
          ← back to studio
        </a>
      </div>
    </div>
  );
}

// A tiny rig that points the camera at LOOK_AT once, then yields control to
// any extras (OrbitControls in the FreeFly variant). Lives inside the Canvas
// because `useThree` requires it.
import { useThree } from "@react-three/fiber";
function FixedLookAt({ target }: { target: [number, number, number] }) {
  const camera = useThree((s) => s.camera);
  const aimed = useRef(false);
  useEffect(() => {
    if (aimed.current) return;
    camera.lookAt(target[0], target[1], target[2]);
    aimed.current = true;
  }, [camera, target]);
  return null;
}
