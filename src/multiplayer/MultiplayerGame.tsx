// MultiplayerGame — Phase 5 networked play view at `#multiplayer`.
//
// What it does
//   • Connects to SpacetimeDB (useValorConnection).
//   • Prompts for a player name (modal). Submit calls `driver.join(name)` and
//     unlocks the shared AudioQueue so subsequent kill barks can play.
//   • Renders the arena + scatter once + the local player rig driven by the
//     server snapshot, plus every other player as a remote rig with a
//     team-color ring under their feet.
//   • Reads input via useKeys, builds a world-space InputSnapshot each frame
//     (WASD rotated into camera basis matches the server's lean integration),
//     and feeds the Driver. Left-click sets a one-frame firePressed edge so
//     the Driver triggers `fire(aim)` immediately. R = reload, C = crouch.
//   • Mounts a dead-player spectator cam (useSpectatorCam) inside the Canvas
//     and a SpectatorOverlay outside.
//   • Subscribes to the live kill stream and enqueues Tier 1 barks on each
//     kill (Phase 4 caster reuse).
//
// We deliberately do not edit Akhil's src/game/* — instead we re-author the
// scene composition (sky, fog, sun, hemi) from GameView.tsx and import only
// the top-level helpers (Arena, FitModel, Scatter, Gun) plus the explicit
// drop-in hooks (useKeys, useSpectatorCam, SpectatorOverlay).

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Sky, Environment } from "@react-three/drei";
import { Vector3 } from "three";
import { Arena, FitModel } from "../Models";
import { Scatter } from "../Scatter";
import { Gun } from "../Gun";
import { useKeys } from "../game/useKeys";
import { useSpectatorCam, SpectatorOverlay } from "../game/SpectatorCam";
import {
  useValorConnection,
  useLocalPlayer,
  usePlayers,
  useGameMatch,
  useShots,
} from "../net/useValor";
import { ValorDriver, type InputSnapshot } from "../net/Driver";
import type { Player, GameMatch, Shot } from "../net/Connection";
import type { AnimState } from "../stdb/types";
import { createLiveKillStream, type LiveStreamController } from "../caster/LiveStream";
import type { KillEvent, Team } from "../caster/MockMatch";
import { pickBark, renderBark } from "../caster/Barks";
import { getSharedAudioQueue } from "../caster/AudioQueue";

const CHAR = "/models/character_b.glb";
const NAME_KEY = "valor.player.name";

// Mirrors src/game/GameView.tsx:27-35 — kept inline so we don't pull the
// import (Akhil's file is on the do-not-touch list, and we'd rather not have
// the multiplayer view break if his CLIP map drifts).
const CLIP: Record<string, string> = {
  idle: "/animations/aiming_idle.glb",
  walk: "/animations/walking.glb",
  strafeL: "/animations/strafe_left.glb",
  strafeR: "/animations/strafe_right.glb",
  fire: "/animations/firing.glb",
  reload: "/animations/reloading.glb",
  crouch: "/animations/crouch_idle.glb",
};

function clipFor(state: AnimState | undefined): string {
  if (!state) return CLIP.idle;
  switch (state.tag) {
    case "Walk":
      return CLIP.walk;
    case "StrafeL":
      return CLIP.strafeL;
    case "StrafeR":
      return CLIP.strafeR;
    case "WalkBack":
      // No dedicated walk-back clip — fall back to walk played at the same speed.
      return CLIP.walk;
    case "Fire":
      return CLIP.fire;
    case "Reload":
      return CLIP.reload;
    case "Crouch":
      return CLIP.crouch;
    case "Idle":
    case "Hit":
    case "Death":
    case "VictoryArms":
    case "GrabbingPistol":
    default:
      return CLIP.idle;
  }
}

function categoryForKill(e: KillEvent): string {
  if (e.isAce) return "ace";
  if (e.isDouble) return "double";
  if (e.isHeadshot) return "headshot";
  if (e.isFirstBlood) return "first_blood";
  return "kill_solo";
}

function teamLabel(t: Team): string {
  return t === "A" ? "Team A" : "Team B";
}

// ---- 3D rigs -------------------------------------------------------------

// Local player rig: position + rotation come from the server snapshot. We
// avoid running our own movement integration so the demo's authority story
// stays clean — what the server says is what you see.
function LocalPlayerRig({ player }: { player: Player | undefined }) {
  if (!player) return null;
  const yaw = Math.atan2(player.aimVector.x, player.aimVector.z) + Math.PI;
  return (
    <group position={[player.position.x, player.position.y, player.position.z]} rotation={[0, yaw, 0]}>
      <FitModel
        url={CHAR}
        height={1.8}
        hold={<Gun length={0.22} variant="normal" />}
        animation={clipFor(player.animState)}
        castShadow
      />
    </group>
  );
}

// Remote player: same FitModel rig, plus a colored ring under feet showing
// the team allegiance. Color matches the in-game caster cam scheme but with
// punchier hues that read clearly across the arena.
function RemotePlayerRig({ player }: { player: Player }) {
  const yaw = Math.atan2(player.aimVector.x, player.aimVector.z) + Math.PI;
  const ringColor = player.team === 0 ? "#4a90e2" : "#e25555";
  return (
    <group position={[player.position.x, player.position.y, player.position.z]} rotation={[0, yaw, 0]}>
      <FitModel
        url={CHAR}
        height={1.8}
        hold={<Gun length={0.22} variant="normal" />}
        animation={clipFor(player.animState)}
        castShadow
      />
      {/* Team ring — slightly above the ground so z-fighting with the arena */}
      {/* mesh doesn't strobe. Emissive so it reads in the fog. */}
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.42, 0.55, 32]} />
        <meshStandardMaterial
          color={ringColor}
          emissive={ringColor}
          emissiveIntensity={0.55}
          transparent
          opacity={0.85}
        />
      </mesh>
    </group>
  );
}

// Mounts useSpectatorCam inside the Canvas (the hook needs useFrame/useThree).
function CamRig({ localPlayer }: { localPlayer: Player | undefined }) {
  useSpectatorCam(localPlayer);
  return null;
}

// ---- Input loop ----------------------------------------------------------

interface InputLoopProps {
  driver: ValorDriver | null;
  localPlayer: Player | undefined;
}

function InputLoop({ driver, localPlayer }: InputLoopProps) {
  const keys = useKeys();
  const { camera, gl } = useThree();

  // Scratch vectors so we don't allocate every frame.
  const fwd = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  const move = useMemo(() => new Vector3(), []);
  const up = useMemo(() => new Vector3(0, 1, 0), []);

  // One-frame fire edge set by pointerdown, consumed each useFrame.
  const firePressedRef = useRef(false);

  useEffect(() => {
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) firePressedRef.current = true;
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, [gl]);

  useFrame(() => {
    if (!driver) return;
    const k = keys.current;

    // Camera-relative basis (pitch flattened) — same trick as GameView.tsx:88-91.
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.crossVectors(fwd, up).normalize();

    // WASD -> world-space velocity. The server reads lean.x / lean.z directly
    // into position += lean * speed * dt (per server/src/lib.rs tick), so we
    // must feed world-space here, not camera-space.
    const f = (k["KeyW"] ? 1 : 0) - (k["KeyS"] ? 1 : 0);
    const s = (k["KeyD"] ? 1 : 0) - (k["KeyA"] ? 1 : 0);
    move.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
    if (move.lengthSq() > 0) move.normalize();

    const snapshot: InputSnapshot = {
      aim: { x: fwd.x, y: fwd.y, z: fwd.z },
      lean: { x: move.x, z: move.z },
      crouch: !!k["KeyC"],
      firePressed: firePressedRef.current,
      reload: !!k["KeyR"],
    };
    firePressedRef.current = false;
    driver.updateInput(snapshot, localPlayer);
  });

  return null;
}

// ---- DOM overlays --------------------------------------------------------

function MatchHud({ match }: { match: GameMatch | undefined }) {
  if (!match) {
    return (
      <div style={hudTopLeft}>
        <div style={hudLabel}>WAITING</div>
        <div style={{ fontSize: 13, opacity: 0.7 }}>No match yet</div>
      </div>
    );
  }
  return (
    <div style={hudTopLeft}>
      <div style={hudLabel}>
        R{match.round} · {match.state.tag.toUpperCase()}
      </div>
      <div style={{ display: "flex", gap: 18, alignItems: "baseline", marginTop: 4 }}>
        <div>
          <span style={{ color: "#4a90e2", fontWeight: 700, fontSize: 20 }}>{match.scoreA}</span>
          <span style={{ opacity: 0.5, margin: "0 8px" }}>vs</span>
          <span style={{ color: "#e25555", fontWeight: 700, fontSize: 20 }}>{match.scoreB}</span>
        </div>
        <div style={{ opacity: 0.65, fontSize: 12 }}>
          {Math.round(Number(match.roundTimerMs) / 1000)}s
        </div>
      </div>
    </div>
  );
}

function PlayerHud({ player }: { player: Player | undefined }) {
  if (!player) return null;
  return (
    <div style={hudBottomLeft}>
      <div style={hudLabel}>{player.name.toUpperCase()}</div>
      <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
        <span style={{ color: player.health > 30 ? "#9be7a3" : "#ff8a6e", fontWeight: 700 }}>
          HP {player.health}
        </span>
        <span style={{ color: player.ammo > 0 ? "#fff" : "#ffb454", fontWeight: 700 }}>
          AMMO {player.ammo}/12
        </span>
        {!player.alive ? <span style={{ color: "#ff8a6e" }}>DOWN</span> : null}
      </div>
    </div>
  );
}

function KillFeed({ kills, playersById }: { kills: Shot[]; playersById: Map<number, Player> }) {
  if (kills.length === 0) {
    return (
      <div style={hudTopRight}>
        <div style={hudLabel}>KILL FEED</div>
        <div style={{ opacity: 0.5, fontSize: 12 }}>No kills yet</div>
      </div>
    );
  }
  return (
    <div style={hudTopRight}>
      <div style={hudLabel}>KILL FEED</div>
      {kills
        .filter((s) => s.victimId !== undefined && s.victimId !== null)
        .map((s) => {
          const killer = playersById.get(s.shooterId);
          const victim = s.victimId !== undefined ? playersById.get(s.victimId) : undefined;
          const killerName = killer?.name ?? `P${s.shooterId}`;
          const victimName = victim?.name ?? (s.victimId !== undefined ? `P${s.victimId}` : "?");
          const killerColor = killer?.team === 0 ? "#4a90e2" : "#e25555";
          const victimColor = victim?.team === 0 ? "#4a90e2" : "#e25555";
          return (
            <div key={String(s.id)} style={{ fontSize: 12, padding: "2px 0" }}>
              <span style={{ color: killerColor, fontWeight: 600 }}>{killerName}</span>
              <span style={{ opacity: 0.6, margin: "0 6px" }}>→</span>
              <span style={{ color: victimColor, fontWeight: 600 }}>{victimName}</span>
            </div>
          );
        })}
    </div>
  );
}

// Centered modal — name prompt before we wire the driver up. Submitting:
//   1. unlocks the shared audio queue (browser autoplay gate),
//   2. issues driver.join(name),
//   3. closes itself.
function JoinForm({
  onSubmit,
  status,
  error,
}: {
  onSubmit: (name: string) => void;
  status: "connecting" | "ready" | "error";
  error: Error | null;
}) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim().slice(0, 16);
    if (!trimmed) return;
    try {
      localStorage.setItem(NAME_KEY, trimmed);
    } catch {
      /* private mode — ignore */
    }
    onSubmit(trimmed);
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(8,10,13,0.78)",
        zIndex: 10,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: "rgba(20,24,28,0.95)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 14,
          padding: "28px 32px",
          minWidth: 340,
          color: "#fff",
          fontFamily: "system-ui, sans-serif",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Join the round</div>
        <div style={{ opacity: 0.65, fontSize: 13, marginBottom: 14 }}>
          {status === "connecting"
            ? "Connecting to SpacetimeDB…"
            : status === "error"
              ? `Connection error: ${error?.message ?? "unknown"}`
              : "Pick a name. The server auto-balances teams on join."}
        </div>
        <input
          type="text"
          value={name}
          autoFocus
          maxLength={16}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 12px",
            fontSize: 16,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(0,0,0,0.4)",
            color: "#fff",
            borderRadius: 8,
            boxSizing: "border-box",
            marginBottom: 14,
          }}
        />
        <button
          type="submit"
          disabled={status !== "ready" || !name.trim()}
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: 15,
            fontWeight: 600,
            background: status === "ready" && name.trim() ? "#3a7bff" : "#2a2f37",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: status === "ready" && name.trim() ? "pointer" : "not-allowed",
          }}
        >
          {status === "ready" ? "Join" : "Waiting…"}
        </button>
        <div style={{ opacity: 0.5, fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
          WASD move · drag orbit · left-click fire · R reload · C crouch
        </div>
      </form>
    </div>
  );
}

// ---- Top-level page ------------------------------------------------------

export function MultiplayerGame() {
  const { conn, status, identity, error } = useValorConnection();
  const players = usePlayers(conn);
  const match = useGameMatch(conn);
  const shots = useShots(conn, 5);
  const localPlayer = useLocalPlayer(conn, identity);

  const playersById = useMemo(() => {
    const map = new Map<number, Player>();
    for (const p of players) map.set(p.id, p);
    return map;
  }, [players]);

  const remotePlayers = useMemo(
    () => (identity ? players.filter((p) => !p.identity.isEqual(identity)) : players),
    [players, identity],
  );

  // Driver lifecycle. Spawn one as soon as the connection is ready; tear it
  // down on unmount or when the connection flips.
  const driverRef = useRef<ValorDriver | null>(null);
  const [driver, setDriver] = useState<ValorDriver | null>(null);
  useEffect(() => {
    if (!conn || status !== "ready") return;
    const d = new ValorDriver(conn, { tickMs: 33 });
    d.start();
    driverRef.current = d;
    setDriver(d);
    return () => {
      d.stop();
      driverRef.current = null;
      setDriver(null);
    };
  }, [conn, status]);

  // Caster — Tier 1 barks on live kill events. We share the AudioQueue with
  // the rest of the app so kills only ever play once even when #caster/live
  // is also open in another tab.
  useEffect(() => {
    if (!conn || status !== "ready") return;
    const queue = getSharedAudioQueue();
    let stream: LiveStreamController | null = createLiveKillStream(conn, {
      onKill: (e: KillEvent) => {
        const template = pickBark(categoryForKill(e));
        const text = renderBark(template, {
          killer: e.killer,
          victim: e.victim,
          team: teamLabel(e.team),
        });
        queue.enqueue({
          text,
          priority: template.priority,
          dedupeKey: `${e.killer}|${e.victim}|${Date.now()}`,
        });
      },
    });
    stream.start();
    return () => {
      stream?.stop();
      stream = null;
    };
  }, [conn, status]);

  // Join modal lifecycle.
  const [joined, setJoined] = useState(false);
  const onJoinSubmit = (name: string) => {
    if (!driverRef.current) return;
    // Browser autoplay gate — must run inside this click handler.
    getSharedAudioQueue().unlock();
    driverRef.current.join(name);
    setJoined(true);
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "#0e1115" }}>
      <Canvas
        shadows
        camera={{ position: [0, 3, 12], fov: 55, near: 0.1, far: 300 }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#bcd4e6"]} />
        <fog attach="fog" args={["#bcd4e6", 60, 220]} />
        <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
        <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
        <directionalLight
          position={[60, 18, 40]}
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
          <Scatter />
          {joined ? <LocalPlayerRig player={localPlayer} /> : null}
          {remotePlayers.map((p) => (
            <RemotePlayerRig key={p.id} player={p} />
          ))}
          <Environment preset="sunset" />
        </Suspense>
        <CamRig localPlayer={localPlayer} />
        {joined ? <InputLoop driver={driver} localPlayer={localPlayer} /> : null}
      </Canvas>

      <MatchHud match={match} />
      <PlayerHud player={localPlayer} />
      <KillFeed kills={shots} playersById={playersById} />
      <SpectatorOverlay localPlayer={localPlayer} match={match} />

      {!joined ? <JoinForm onSubmit={onJoinSubmit} status={status} error={error} /> : null}

      <a
        href="#"
        style={{
          position: "absolute",
          bottom: 14,
          right: 14,
          color: "#7db0ff",
          fontSize: 12,
          fontFamily: "system-ui, sans-serif",
          background: "rgba(20,24,28,0.78)",
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        ← back to studio
      </a>
    </div>
  );
}

// ---- styles --------------------------------------------------------------

const hudBase: React.CSSProperties = {
  position: "absolute",
  padding: "9px 13px",
  background: "rgba(20,24,28,0.82)",
  color: "#fff",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.08)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  font: "13px/1.3 system-ui, sans-serif",
  userSelect: "none",
  pointerEvents: "none",
};

const hudTopLeft: React.CSSProperties = { ...hudBase, top: 16, left: 16, minWidth: 180 };
const hudTopRight: React.CSSProperties = { ...hudBase, top: 16, right: 16, minWidth: 180 };
const hudBottomLeft: React.CSSProperties = { ...hudBase, bottom: 16, left: 16, minWidth: 180 };

const hudLabel: React.CSSProperties = {
  fontSize: 10,
  opacity: 0.65,
  letterSpacing: 0.7,
  fontWeight: 600,
};
