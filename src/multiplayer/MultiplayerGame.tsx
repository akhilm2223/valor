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

import { Component, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Sky } from "@react-three/drei";
import { Arena, FitModel } from "../Models";
import { Scatter } from "../Scatter";
import { Gun } from "../Gun";
import { useSpectatorCam, SpectatorOverlay } from "../game/SpectatorCam";
import { QrJoinBadge } from "../spectator/QrJoinBadge";
import { FpvArms } from "../game/FpvArms";
import { VisionController } from "../game/VisionController";
import { InputController } from "../game/input";
import { useControls } from "../game/stores";
import { CAPSULE } from "../game/contracts";
import {
  useValorConnection,
  useLocalPlayer,
  usePlayers,
  useGameMatch,
  useShots,
} from "../net/useValor";
import { ValorDriver } from "../net/Driver";
import type { Player, GameMatch, Shot } from "../net/Connection";
import { encodeName, decodeName, DEFAULT_MODEL_URL } from "../net/playerModel";
import type { AnimState } from "../stdb/types";
import { createLiveKillStream, type LiveStreamController } from "../caster/LiveStream";
import type { KillEvent, Team } from "../caster/MockMatch";
import { pickBark, renderBark } from "../caster/Barks";
import { getSharedAudioQueue } from "../caster/AudioQueue";

const NAME_KEY = "valor.player.name";
const MODEL_KEY = "valor.player.model";

// Isolates a sub-tree so a failed asset load (e.g. a clip GLB that a browser
// cached corrupt) renders nothing instead of throwing up through Suspense and
// tearing down the whole Canvas — which is exactly what turned the screen black.
// Each rig / the FPV arms gets its own boundary so one bad load is contained.
class AssetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("[valor] asset failed to load — skipping it, scene stays up:", err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The model the local player picked in the lobby (fallback to default). Sent
 *  encoded into the join name (see net/playerModel) so every client renders the
 *  right body for this player — the model is network-synced via the name field. */
function selectedModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? DEFAULT_MODEL_URL;
  } catch {
    return DEFAULT_MODEL_URL;
  }
}

// Mirrors src/game/GameView.tsx:27-35 — kept inline so we don't pull the
// import (Akhil's file is on the do-not-touch list, and we'd rather not have
// the multiplayer view break if his CLIP map drifts).
// `?v=2` cache-buster — see ANIM_CLIPS in contracts.ts. Some clip GLBs got
// cached corrupt from the first (41 MB) deploy; the new URL forces a clean fetch.
const CLIP: Record<string, string> = {
  idle: "/animations/aiming_idle.glb?v=2",
  walk: "/animations/walking.glb?v=2",
  strafeL: "/animations/strafe_left.glb?v=2",
  strafeR: "/animations/strafe_right.glb?v=2",
  fire: "/animations/firing.glb?v=2",
  reload: "/animations/reloading.glb?v=2",
  crouch: "/animations/crouch_idle.glb?v=2",
};

function clipFor(state: AnimState | undefined): string {
  if (!state) return CLIP.idle;
  switch (state.tag) {
    case "Walk":
      return CLIP.walk;
    case "StrafeL":
    case "StrafeR":
    case "WalkBack":
      // Strafe/back share the walk clip: a single deployed copy of strafe_right
      // .glb was landing corrupt in some browser caches and its uncaught load
      // error tore down the whole Canvas. Walk always loads, so use it for all
      // lateral/back locomotion until the strafe clips are re-exported.
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
        url={decodeName(player.name).modelUrl}
        height={1.8}
        hold={<Gun length={0.22} variant="normal" />}
        animation={clipFor(player.animState)}
        castShadow
      />
    </group>
  );
}

// Deterministic lateral fan offset (same on every client) so players sharing a
// team spawn point don't render stacked inside each other. Golden-angle spread.
function fanOffset(id: number): [number, number] {
  const a = id * 2.39996323; // golden angle (radians)
  const r = 1.35;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

// Remote player: same FitModel rig, plus a colored ring under feet showing
// the team allegiance. Color matches the in-game caster cam scheme but with
// punchier hues that read clearly across the arena.
//
// De-overlap: the server spawns every team member at ONE point (SPAWN_A/B), so
// teammates stack — and since your camera sits at your own spawn, an ally ends
// up rendered inside your face. We fan TEAMMATES out by a cosmetic offset (you
// can't shoot them, so visual-only is fine). OPPONENTS render at their true
// server position so aim + hit registration stay honest.
function RemotePlayerRig({ player, localTeam }: { player: Player; localTeam?: number }) {
  const yaw = Math.atan2(player.aimVector.x, player.aimVector.z) + Math.PI;
  const ringColor = player.team === 0 ? "#4a90e2" : "#e25555";
  const sameTeam = localTeam !== undefined && player.team === localTeam;
  const [ox, oz] = sameTeam ? fanOffset(player.id) : [0, 0];
  return (
    <group position={[player.position.x + ox, player.position.y, player.position.z + oz]} rotation={[0, yaw, 0]}>
      <FitModel
        url={decodeName(player.name).modelUrl}
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

// WebGL context-loss recovery. By default a lost context is GONE — the canvas
// stays black forever. Calling preventDefault() on `webglcontextlost` tells the
// browser to keep the canvas so it can fire `webglcontextrestored`, at which
// point three re-inits its GL state and rendering resumes. Without this, the
// MediaPipe-induced GPU pressure that drops the context = permanent black screen.
function ContextRecovery() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (e: Event) => {
      e.preventDefault();
      console.warn("[valor] WebGL context lost — attempting recovery…");
    };
    const onRestored = () => console.warn("[valor] WebGL context restored");
    canvas.addEventListener("webglcontextlost", onLost as EventListener, false);
    canvas.addEventListener("webglcontextrestored", onRestored as EventListener, false);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      canvas.removeEventListener("webglcontextrestored", onRestored as EventListener);
    };
  }, [gl]);
  return null;
}

// ---- Vision input bridge -------------------------------------------------
//
// Translates Akhil's body-control `useControls` store (written by
// VisionController / InputController) into the networked InputSnapshot the
// Driver wants, and owns the first-person camera while the local player is
// alive. This is the seam from INTEGRATION.md — a pure translation layer that
// touches none of src/game/*.
//
//   • TURN  — `yawDelta` accumulates in useControls (vision finger-count or
//     mouse). We are the SOLE consumer in MP: accumulate into `yaw`, then zero
//     the deltas back into the store each frame (mirrors PlayerController).
//   • MOVE  — moveForward/Back (+ keyboard strafe) → world-space `lean`. The
//     server integrates `position += lean * speed * dt`, so we feed WORLD space
//     rotated by our yaw, not camera space.
//   • AIM   — default look direction is camera-forward (flat). If an enemy sits
//     near the crosshair we send the LOCK-corrected vector pointing at their
//     capsule center, so the server's raycast lands on them — aim assist runs
//     server-side and can't be cheated. This is what makes body-aim (no pitch)
//     playable.
//   • FIRE/RELOAD — one-frame edge pulses in useControls; we read + clear them
//     (we are the consumer in MP). The Driver fires on the rising edge.
//
// Camera ownership: we only drive the camera while alive. When dead, we bail
// and useSpectatorCam takes over (it no-ops while alive, so no conflict).

const HEAD_OFFSET_Y = 1.35; // server shooter ray origin (server/src/lib.rs)
const CENTER_OFFSET_Y = 0.9; // server victim center = position.y + PLAYER_HEIGHT*0.5
const ASSIST_RANGE = 60; // m — matches server MAX_RANGE
const ASSIST_COS = Math.cos((25 * Math.PI) / 180); // generous cone (body-aim is coarse)

/** Wrap an angle into (-π, π] so accumulated yaw never drifts unbounded. */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Nearest-to-crosshair living enemy within the assist cone + range, as a unit
 *  aim vector from our head to their capsule center (so the server ray hits).
 *  Returns null if nothing qualifies (then we send plain camera-forward). */
function pickAssistAim(
  me: Player,
  players: Player[],
  fx: number,
  fz: number,
): { x: number; y: number; z: number } | null {
  const headY = me.position.y + HEAD_OFFSET_Y;
  let best: { x: number; y: number; z: number } | null = null;
  let bestCos = ASSIST_COS;
  for (const p of players) {
    if (p.id === me.id || p.team === me.team || !p.alive) continue;
    const dx = p.position.x - me.position.x;
    const dy = p.position.y + CENTER_OFFSET_Y - headY;
    const dz = p.position.z - me.position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3 || dist > ASSIST_RANGE) continue;
    const inv = 1 / dist;
    // Cone test on the horizontal plane (yaw only); aim itself keeps the y so
    // the shot rises/falls onto the target — that's the vertical assist.
    const flat = Math.hypot(dx, dz) || 1;
    const cos = (fx * dx + fz * dz) / flat;
    if (cos > bestCos) {
      bestCos = cos;
      best = { x: dx * inv, y: dy * inv, z: dz * inv };
    }
  }
  return best;
}

interface VisionInputBridgeProps {
  driver: ValorDriver | null;
  localPlayer: Player | undefined;
  players: Player[];
}

function VisionInputBridge({ driver, localPlayer, players }: VisionInputBridgeProps) {
  const camera = useThree((s) => s.camera);
  const yaw = useRef(0);
  // Have we oriented the camera for the current life yet? (reset on death.)
  const yawInit = useRef(false);
  // Smoothed feet position. Server position lands at 30Hz; we render at 60+Hz,
  // so hard-setting the camera each frame stutters. Exponentially chase the
  // server pos instead (light client-side smoothing — INTEGRATION.md Task 3).
  const smooth = useRef<{ x: number; y: number; z: number } | null>(null);

  useEffect(() => {
    camera.rotation.order = "YXZ";
  }, [camera]);

  useFrame((_, dtRaw) => {
    if (!driver || !localPlayer) return;
    const ctrl = useControls.getState();

    // ── Face the arena on (re)spawn ────────────────────────────────────────
    // The server orients each team's spawn aim toward the opponent (team A → -Z,
    // team B → +Z). Seed our yaw from it ONCE per life. WITHOUT this the camera
    // hardcodes yaw=0 (-Z), so a player spawned on the far side (z=-8) faces AWAY
    // from the arena into empty sky — the "plain screen" bug. atan2(-x,-z) maps
    // the forward aim vector back to a yaw in our (-sinY,-cosY) basis.
    if (localPlayer.alive) {
      if (!yawInit.current) {
        const a = localPlayer.aimVector;
        if (a && (a.x !== 0 || a.z !== 0)) {
          yaw.current = Math.atan2(-a.x, -a.z);
          yawInit.current = true;
        }
      }
    } else {
      yawInit.current = false;
    }

    // ── Look: consume + zero the deltas (sole consumer in MP) ──────────────
    yaw.current = wrapAngle(yaw.current - ctrl.yawDelta);
    if (ctrl.yawDelta !== 0 || ctrl.pitchDelta !== 0) {
      useControls.setState({ yawDelta: 0, pitchDelta: 0 });
    }

    // Yaw-only basis. yaw=0 faces -Z (three default); right = +X.
    const cy = Math.cos(yaw.current);
    const sy = Math.sin(yaw.current);
    const fx = -sy, fz = -cy; // forward XZ
    const rx = cy, rz = -sy; // right XZ

    // ── Move → world-space lean (server adds lean*speed*dt to x/z) ─────────
    const moveAxis = (ctrl.moveForward ? 1 : 0) - (ctrl.moveBack ? 1 : 0);
    const strafeAxis = (ctrl.strafeRight ? 1 : 0) - (ctrl.strafeLeft ? 1 : 0);
    let lx = fx * moveAxis + rx * strafeAxis;
    let lz = fz * moveAxis + rz * strafeAxis;
    const len = Math.hypot(lx, lz);
    if (len > 1) { lx /= len; lz /= len; }

    // ── Aim → camera-forward, bent onto the nearest enemy by aim assist ────
    const assist = pickAssistAim(localPlayer, players, fx, fz);
    const aim = assist ?? { x: fx, y: 0, z: fz };

    // ── Fire / reload edge pulses — read + clear (we're the consumer) ──────
    const firePressed = ctrl.firePressed;
    const reload = ctrl.reloadPressed;
    if (firePressed || reload) {
      useControls.setState({ firePressed: false, reloadPressed: false });
    }

    driver.updateInput(
      { aim, lean: { x: lx, z: lz }, crouch: ctrl.crouch, firePressed, reload },
      localPlayer,
    );

    // ── First-person camera (only while alive; spectator cam owns it dead) ─
    if (localPlayer.alive) {
      const p = localPlayer.position;
      // Snap on first frame / after respawn jumps; otherwise smooth-chase.
      if (!smooth.current || Math.hypot(p.x - smooth.current.x, p.z - smooth.current.z) > 4) {
        smooth.current = { x: p.x, y: p.y, z: p.z };
      } else {
        const alpha = 1 - Math.exp(-18 * Math.min(dtRaw, 0.05));
        smooth.current.x += (p.x - smooth.current.x) * alpha;
        smooth.current.y += (p.y - smooth.current.y) * alpha;
        smooth.current.z += (p.z - smooth.current.z) * alpha;
      }
      const eye = ctrl.crouch ? CAPSULE.crouchEye : CAPSULE.standEye;
      camera.position.set(smooth.current.x, smooth.current.y + eye, smooth.current.z);
      camera.rotation.set(0, yaw.current, 0, "YXZ");
    } else {
      smooth.current = null; // reset so respawn snaps cleanly
    }

    // TEMP DEBUG (remove): expose live camera + player numbers for diagnosis.
    (window as unknown as Record<string, unknown>).__dbg = {
      cam: [+camera.position.x.toFixed(1), +camera.position.y.toFixed(1), +camera.position.z.toFixed(1)],
      rotY: +camera.rotation.y.toFixed(2),
      ppos: [+localPlayer.position.x.toFixed(1), +localPlayer.position.y.toFixed(1), +localPlayer.position.z.toFixed(1)],
      alive: localPlayer.alive,
      team: localPlayer.team,
      aim: [+localPlayer.aimVector.x.toFixed(2), +localPlayer.aimVector.z.toFixed(2)],
    };
  });

  return null;
}

// ---- DOM overlays --------------------------------------------------------

// Center crosshair dot — a fixed reference for where the camera (and thus the
// pre-assist aim) points. Aim assist bends the actual shot onto a nearby enemy.
function Crosshair() {
  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: 6,
        height: 6,
        marginLeft: -3,
        marginTop: -3,
        borderRadius: "50%",
        background: "rgba(255,255,255,0.85)",
        boxShadow: "0 0 0 1.5px rgba(0,0,0,0.55)",
        pointerEvents: "none",
        zIndex: 5,
      }}
    />
  );
}

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
      <div style={hudLabel}>{decodeName(player.name).name.toUpperCase()}</div>
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
          const killerName = killer ? decodeName(killer.name).name : `P${s.shooterId}`;
          const victimName = victim ? decodeName(victim.name).name : (s.victimId !== undefined ? `P${s.victimId}` : "?");
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
          Body: ✊both palms to start · LEFT hand 1 fwd / 2 back / 3 turn R / 4 turn L ·
          RIGHT ✊ fire · wink to scope.
          <br />
          Keyboard fallback: WASD move · mouse turn · click fire · R reload · C crouch.
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

  // Live refs mirroring the hook return values — the dev hook below exposes
  // these via getters so an automated smoke script always reads the latest
  // tick, not the snapshot captured at mount.
  const localPlayerRef = useRef(localPlayer);
  const playersRef = useRef(players);
  const matchRef = useRef(match);
  useEffect(() => {
    localPlayerRef.current = localPlayer;
  }, [localPlayer]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

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

  // Dev-only handle so an automated browser smoke test can drive the live
  // multiplayer session — fire reducers directly, inspect server state — and
  // never leak into the production bundle (import.meta.env.DEV guard). Mirrors
  // src/game/GameScene.tsx's `window.__mosh` pattern. The getters read through
  // the refs above so callers always see the latest tick, not a stale closure.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!conn || !driver || !identity) return;
    (window as unknown as { __valor?: unknown }).__valor = {
      conn,
      driver,
      identity,
      get localPlayer() {
        return localPlayerRef.current;
      },
      get players() {
        return playersRef.current;
      },
      get match() {
        return matchRef.current;
      },
    };
    return () => {
      delete (window as { __valor?: unknown }).__valor;
    };
  }, [conn, driver, identity]);

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
    // Encode the chosen model into the join name so it syncs to every client
    // (no server schema change needed — see net/playerModel).
    driverRef.current.join(encodeName(name, selectedModel()));
    setJoined(true);
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "#0e1115" }}>
      <Canvas
        camera={{ position: [0, 3, 12], fov: 55, near: 0.1, far: 300 }}
        dpr={[1, 1.5]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        {/* GPU budget: this page also runs two MediaPipe WebGL contexts (hand +
            face), so the main scene is deliberately light — no shadow maps, no
            HDR environment, capped DPR — to avoid exhausting integrated GPUs
            (which caused the "Context Lost" black screen on Edge). */}
        <ContextRecovery />
        <color attach="background" args={["#bcd4e6"]} />
        <fog attach="fog" args={["#bcd4e6", 60, 220]} />
        <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
        <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
        <directionalLight position={[60, 18, 40]} intensity={2.2} />
        <Suspense fallback={null}>
          <Arena />
          <Scatter />
          {/* First-person: hide our own body while alive (camera sits at the
              eye). Render it when dead so the spectator orbit sees the corpse. */}
          {joined && localPlayer && !localPlayer.alive ? (
            <AssetBoundary>
              <LocalPlayerRig player={localPlayer} />
            </AssetBoundary>
          ) : null}
          {remotePlayers.map((p) => (
            <AssetBoundary key={p.id}>
              <RemotePlayerRig player={p} localTeam={localPlayer?.team} />
            </AssetBoundary>
          ))}
          {/* First-person arms + gun (same rig single-player uses), shown only
              while alive. Tracks the camera; head bones collapsed so your own
              face never fills the screen. Boundaried: if a clip GLB fails to
              load, the arms just don't show — the scene never goes black. */}
          {joined && localPlayer?.alive ? (
            <AssetBoundary>
              <FpvArms />
            </AssetBoundary>
          ) : null}
        </Suspense>
        <CamRig localPlayer={localPlayer} />
        {joined ? (
          <>
            <VisionInputBridge driver={driver} localPlayer={localPlayer} players={players} />
            {/* Keyboard/mouse fallback — writes the SAME useControls store the
                webcam does, so testing without a camera still works. */}
            <InputController />
          </>
        ) : null}
      </Canvas>

      <MatchHud match={match} />
      <PlayerHud player={localPlayer} />
      <KillFeed kills={shots} playersById={playersById} />
      <SpectatorOverlay localPlayer={localPlayer} match={match} />

      {/* Crosshair — body-aim is coarse, so show where the camera points. */}
      {joined && localPlayer?.alive ? <Crosshair /> : null}

      {/* Webcam body control (DOM overlay — owns a <video>, must be OUTSIDE the
          Canvas). Mounted only after joining so we don't grab the camera early.
          Writes useControls, which VisionInputBridge consumes. */}
      {joined ? <VisionController /> : null}

      {!joined ? <JoinForm onSubmit={onJoinSubmit} status={status} error={error} /> : null}

      {/* QR badge — bottom-right corner, above the back-to-studio link.
          Anyone with a phone can scan to spectate the running match. */}
      <QrJoinBadge
        style={{ position: "absolute", bottom: 56, right: 14, zIndex: 4 }}
        size={88}
      />

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
