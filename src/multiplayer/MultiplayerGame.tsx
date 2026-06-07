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
import { Sky, Environment } from "@react-three/drei";
import { Raycaster, Vector3, MathUtils, type Group, type PerspectiveCamera } from "three";
import { Arena, FitModel } from "../Models";
import { Scatter } from "../Scatter";
import { Gun } from "../Gun";
import { useSpectatorCam, SpectatorOverlay } from "../game/SpectatorCam";
import { FpvArms } from "../game/FpvArms";
import { VisionController } from "../game/VisionController";
import { InputController } from "../game/input";
import { useControls } from "../game/stores";
import { CAPSULE, type AnimState as FpvAnimState } from "../game/contracts";
import { playSfx, initAudio } from "../game/sfx";
import { vfx, Vfx } from "../game/vfx";
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

// Map the server anim enum to the FPV-arms clip state (the contracts AnimState
// union AnimatedCharacter crossfades between). So your own hands walk, strafe,
// crouch and reload from the server's view instead of being frozen in idle.
function fpvAnimFor(state: AnimState | undefined): FpvAnimState {
  switch (state?.tag) {
    case "Walk":
    case "WalkBack":
      return "walk";
    case "StrafeL":
      return "strafeLeft";
    case "StrafeR":
      return "strafeRight";
    case "Crouch":
      return "crouchIdle";
    case "Fire":
      return "fire";
    case "Reload":
      return "reload";
    case "Death":
      return "death";
    default:
      return "idle";
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
function RemotePlayerRig({
  player,
  localTeam,
  arenaRef,
}: {
  player: Player;
  localTeam?: number;
  arenaRef: React.RefObject<Group | null>;
}) {
  const ringColor = player.team === 0 ? "#4a90e2" : "#e25555";
  const sameTeam = localTeam !== undefined && player.team === localTeam;

  // Ground-snap the body to the terrain, like the camera. The server keeps every
  // player at y=0 (no gravity) on a bumpy floor, so rendering at raw y=0 leaves
  // opponents floating in the air. Raycast the arena under them (throttled) and
  // stand them on the floor. Position + facing are written in useFrame so they
  // track the 30Hz server updates smoothly.
  const groupRef = useRef<Group>(null);
  const rc = useRef(new Raycaster());
  const scratch = useRef(new Vector3());
  const frame = useRef(0);
  const groundYRef = useRef(player.position.y);
  // Smoothed render transform. The server lands positions at ~30Hz but we render
  // at 60+Hz, so writing the raw server pos each frame makes remote players STEP
  // (the "not smooth" jitter). Exponentially chase the target so they glide.
  const smoothRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const yawRef = useRef(Math.atan2(player.aimVector.x, player.aimVector.z) + Math.PI);
  useFrame((_, dt) => {
    const g = groupRef.current;
    if (!g) return;
    const [ox, oz] = sameTeam ? fanOffset(player.id) : [0, 0];
    const px = player.position.x + ox;
    const pz = player.position.z + oz;
    const arena = arenaRef.current;
    if (arena && frame.current++ % 12 === 0) {
      rc.current.set(scratch.current.set(px, 200, pz), DOWN);
      const hits = rc.current.intersectObject(arena, true);
      for (const h of hits) {
        if (h.point.y > -60 && h.point.y < 150) { groundYRef.current = h.point.y; break; }
      }
    }
    // Entity interpolation. Snap on first frame / big teleports (respawn) so a
    // player doesn't ski across the whole arena; otherwise damp toward target.
    const ty = groundYRef.current;
    let sm = smoothRef.current;
    if (!sm || Math.hypot(px - sm.x, pz - sm.z) > 4) {
      sm = { x: px, y: ty, z: pz };
      smoothRef.current = sm;
    } else {
      const k = 1 - Math.exp(-14 * Math.min(dt, 0.05));
      sm.x += (px - sm.x) * k;
      sm.y += (ty - sm.y) * k;
      sm.z += (pz - sm.z) * k;
    }
    g.position.set(sm.x, sm.y, sm.z);
    // Smooth the facing too (shortest-arc), so turns don't snap.
    const targetYaw = Math.atan2(player.aimVector.x, player.aimVector.z) + Math.PI;
    let d = targetYaw - yawRef.current;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    yawRef.current += d * (1 - Math.exp(-14 * Math.min(dt, 0.05)));
    g.rotation.set(0, yawRef.current, 0);
  });
  return (
    <group ref={groupRef}>
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

// Explicit render pass — REQUIRED. FpvArms runs a positive-priority useFrame
// (priority 11, to track the camera after recoil), and the instant any useFrame
// has a positive priority R3F disables its automatic render and expects us to
// render manually. Without this, the canvas renders fine until you spawn alive
// (which mounts FpvArms) and then goes BLACK. We render last (priority 1000),
// after the camera write (VisionInputBridge, priority 0) and the arms (11).
// Mirrors GameScene.tsx's RenderPass.
function RenderPass() {
  useFrame(({ gl, scene, camera }) => gl.render(scene, camera), 1000);
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
const DOWN = new Vector3(0, -1, 0); // ground-snap raycast direction

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

// First-person feel constants (mirrors single-player Weapon.tsx so MP fires/
// scopes the same way). The Canvas camera is created at fov 55; scope zooms to
// 40 (~1.4×). Recoil is a transient pitch kick recovered each frame.
const NORMAL_FOV = 55;
const SCOPED_FOV = 40;
const AIM_LERP = 12; // fov damp rate toward target
const RECOIL_KICK = 0.05; // radians of upward pitch per shot
const RECOIL_RECOVER = 14; // damp rate back to neutral
// Gun-barrel offset in the camera's local frame (right, down, forward=-Z) — the
// muzzle/tracer origin so the streak leaves the held gun, not your eye.
const MUZZLE_LOCAL = new Vector3(0.18, -0.16, -0.62);
const TRACER_RANGE = 60; // how far the tracer streaks along the aim (= server MAX_RANGE)

interface VisionInputBridgeProps {
  driver: ValorDriver | null;
  localPlayer: Player | undefined;
  players: Player[];
  arenaRef: React.RefObject<Group | null>;
  // Called (only on change) when aim-assist acquires/loses a target, so the HUD
  // crosshair can show the player WHERE the gun will actually shoot.
  onLockChange?: (locked: boolean) => void;
}

function VisionInputBridge({ driver, localPlayer, players, arenaRef, onLockChange }: VisionInputBridgeProps) {
  const lockedPrev = useRef(false);
  const camera = useThree((s) => s.camera);
  const rc = useRef(new Raycaster());
  const rayOrigin = useRef(new Vector3());
  const groundY = useRef(0);
  const rcFrame = useRef(0);
  const yaw = useRef(0);
  // Transient recoil pitch (radians). Kicked on fire, damped back to 0.
  const recoilPitch = useRef(0);
  // Scratch vector for computing the muzzle world position each shot.
  const muzzlePos = useRef(new Vector3());
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
    // Surface lock state to the HUD (only on change — cheap). `assist` non-null
    // means an enemy is in the cone and the shot WILL bend onto them.
    const locked = assist !== null;
    if (locked !== lockedPrev.current) {
      lockedPrev.current = locked;
      onLockChange?.(locked);
    }

    // ── Fire / reload edge pulses — read + clear (we're the consumer) ──────
    const firePressed = ctrl.firePressed;
    const reload = ctrl.reloadPressed;
    if (firePressed || reload) {
      useControls.setState({ firePressed: false, reloadPressed: false });
    }

    // ── Local fire feedback — the server's fire() reducer handles damage, but
    // it sends back NO muzzle/recoil/sound, so without this the trigger feels
    // dead even though ammo ticks down. Fire the feel locally on the rising edge
    // (gated the same way the Driver gates the reducer: alive + ammo) so the
    // shot looks/sounds fired the instant you pull. reload plays its rack.
    if (firePressed && localPlayer.alive && localPlayer.ammo > 0) {
      playSfx("shot");
      recoilPitch.current += RECOIL_KICK;
      // Muzzle flash + tracer at the gun barrel, streaking along the (assisted)
      // aim — same pooled VFX single-player uses, so bullets read as real rounds
      // leaving the gun, not just a sound. Tracer fades in ~60ms so overshooting
      // the actual hit point along `aim` is invisible.
      const mz = muzzlePos.current.copy(MUZZLE_LOCAL).applyQuaternion(camera.quaternion).add(camera.position);
      vfx.muzzle([mz.x, mz.y, mz.z]);
      vfx.tracer(
        [mz.x, mz.y, mz.z],
        [mz.x + aim.x * TRACER_RANGE, mz.y + aim.y * TRACER_RANGE, mz.z + aim.z * TRACER_RANGE],
      );
    }
    if (reload) playSfx("reload");

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
      // Ground-snap: the server keeps every player at y=0 with NO gravity, but
      // the arena terrain swings from −5 to +2, so y=0 buries/floats the camera
      // and you see only the sky-coloured background ("all white"). Raycast the
      // floor under us (throttled — the terrain is a heavy un-indexed trimesh)
      // and sit the camera at floor + eye, the way single-player's physics does.
      // Raycast ONLY the arena — NOT the whole scene. The scene also contains the
      // FPV arms (glued to the camera) and other player rigs; hitting those made
      // groundY chase the camera and launched it into the sky (blank screen).
      const arena = arenaRef.current;
      if (arena && rcFrame.current++ % 10 === 0) {
        rc.current.set(rayOrigin.current.set(smooth.current.x, 200, smooth.current.z), DOWN);
        const hits = rc.current.intersectObject(arena, true);
        for (const h of hits) {
          if (h.point.y > -60 && h.point.y < 150) { groundY.current = h.point.y; break; }
        }
      }
      camera.position.set(smooth.current.x, groundY.current + eye, smooth.current.z);
      // Recoil: transient upward pitch on top of the yaw-only body aim, damped
      // back to neutral. Negative X pitches the view up (YXZ order).
      recoilPitch.current = MathUtils.damp(recoilPitch.current, 0, RECOIL_RECOVER, dtRaw);
      camera.rotation.set(-recoilPitch.current, yaw.current, 0, "YXZ");

      // Scope / aim-down-sights: wink (one eye closed) sets ctrl.aiming; lerp the
      // camera FOV toward zoomed. Same behavior as single-player Weapon.tsx.
      const cam = camera as PerspectiveCamera;
      if (cam.isPerspectiveCamera) {
        const targetFov = ctrl.aiming ? SCOPED_FOV : NORMAL_FOV;
        if (Math.abs(cam.fov - targetFov) > 0.05) {
          cam.fov = MathUtils.damp(cam.fov, targetFov, AIM_LERP, dtRaw);
          cam.updateProjectionMatrix();
        }
      }
    } else {
      smooth.current = null; // reset so respawn snaps cleanly
      recoilPitch.current = 0;
      // Hand a clean (un-zoomed) FOV back to the spectator cam on death.
      const cam = camera as PerspectiveCamera;
      if (cam.isPerspectiveCamera && Math.abs(cam.fov - NORMAL_FOV) > 0.05) {
        cam.fov = NORMAL_FOV;
        cam.updateProjectionMatrix();
      }
    }

    // TEMP DEBUG (remove): movement diagnosis. animState reflects the SERVER's
    // view of our lean (it sets Walk/Idle in submit_input) → proves whether the
    // reducer call lands. serverLean is what the server stored.
    (window as unknown as Record<string, unknown>).__dbg = {
      ppos: [+localPlayer.position.x.toFixed(2), +localPlayer.position.z.toFixed(2)],
      lean: [+lx.toFixed(2), +lz.toFixed(2)],
      serverLean: [+localPlayer.lean.x.toFixed(2), +localPlayer.lean.z.toFixed(2)],
      anim: localPlayer.animState?.tag,
      mF: ctrl.moveForward,
    };
  });

  return null;
}

// ---- DOM overlays --------------------------------------------------------

// Center crosshair — where the camera (and gun) points. A proper 4-tick cross +
// dot so you can actually SEE your aim. When aim-assist has an enemy in the cone
// it turns RED with a lock bracket + label, telling you the shot will bend onto
// them — that's the "auto-aim" made visible.
function Crosshair({ locked = false }: { locked?: boolean }) {
  const color = locked ? "#ff3b3b" : "rgba(255,255,255,0.95)";
  const shadow = "0 0 0 1px rgba(0,0,0,0.65)";
  const tick = (s: React.CSSProperties) => (
    <div style={{ position: "absolute", top: "50%", left: "50%", background: color, boxShadow: shadow, ...s }} />
  );
  return (
    <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 44, height: 44, pointerEvents: "none", zIndex: 5 }}>
      <div style={{ position: "absolute", top: "50%", left: "50%", width: 4, height: 4, marginLeft: -2, marginTop: -2, borderRadius: "50%", background: color, boxShadow: shadow }} />
      {tick({ width: 2, height: 9, marginLeft: -1, marginTop: -17 })}
      {tick({ width: 2, height: 9, marginLeft: -1, marginTop: 8 })}
      {tick({ width: 9, height: 2, marginLeft: -17, marginTop: -1 })}
      {tick({ width: 9, height: 2, marginLeft: 8, marginTop: -1 })}
      {locked && (
        <>
          <div style={{ position: "absolute", top: "50%", left: "50%", width: 32, height: 32, marginLeft: -16, marginTop: -16, border: `2px solid ${color}`, borderRadius: 5, boxShadow: shadow }} />
          <div style={{ position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: 6, color, fontSize: 10, fontWeight: 800, letterSpacing: 1, textShadow: "0 1px 2px rgba(0,0,0,0.8)", whiteSpace: "nowrap" }}>
            ● LOCKED
          </div>
        </>
      )}
    </div>
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

  // Other players to render: not us, and ALIVE only. The server never deletes a
  // disconnected player (it just sets alive=false), so without this filter every
  // stale test session lingers as a body — that's the phantom "1v2 / everyone
  // stacked in one spot" the scene was showing.
  const remotePlayers = useMemo(
    () =>
      players.filter(
        (p) => p.alive && (identity ? !p.identity.isEqual(identity) : true),
      ),
    [players, identity],
  );

  // The arena geometry, isolated in a ref'd group so the camera ground-snap
  // raycast can hit ONLY the terrain (never the FPV arms or player rigs).
  const arenaRef = useRef<Group>(null);

  // Crosshair lock state — set by VisionInputBridge when aim-assist acquires an
  // enemy (only flips on change, so this re-render is rare).
  const [aimLocked, setAimLocked] = useState(false);

  // Combat reactions from the server's shot stream. For every NEW shot row we
  //   • play gunfire (enemy shots only — our own already cracked on the local
  //     fire edge, so we'd double it),
  //   • draw a muzzle flash + tracer from the SHOOTER's gun to the hit point (or
  //     out along their aim) so enemy fire reads as real rounds, not just sound,
  //   • play a hit thock when one of OUR shots connects.
  // Track the highest shot id so we only react to genuinely new rows, not the
  // backlog already in the table at mount.
  const lastShotId = useRef<bigint | null>(null);
  useEffect(() => {
    const myId = localPlayer?.id;
    for (const s of shots) {
      if (lastShotId.current === null || s.id <= lastShotId.current) continue;
      const mine = s.shooterId === myId;
      if (!mine) {
        playSfx("shot", 0.7); // enemy gunfire
        const shooter = playersById.get(s.shooterId);
        if (shooter) {
          const ox = shooter.position.x;
          const oy = shooter.position.y + HEAD_OFFSET_Y;
          const oz = shooter.position.z;
          let ex = ox + s.aimVector.x * TRACER_RANGE;
          let ey = oy + s.aimVector.y * TRACER_RANGE;
          let ez = oz + s.aimVector.z * TRACER_RANGE;
          if (s.hit && s.victimId != null) {
            const v = playersById.get(s.victimId);
            if (v) { ex = v.position.x; ey = v.position.y + 0.9; ez = v.position.z; }
          }
          vfx.muzzle([ox, oy, oz]);
          vfx.tracer([ox, oy, oz], [ex, ey, ez]);
        }
      } else if (s.hit) {
        playSfx("hit"); // our shot connected
      }
    }
    const maxId = shots.reduce((m, s) => (s.id > m ? s.id : m), lastShotId.current ?? -1n);
    lastShotId.current = maxId;
  }, [shots, localPlayer, playersById]);

  // Death sounds: watch every player's alive flag for a true→false flip and play
  // a scream (a sharper, full-volume cue when it's US going down). Driven off the
  // players table — not the shot row — so it fires reliably even when the lethal
  // shot and the health update land on different ticks.
  const alivePrev = useRef<Map<number, boolean>>(new Map());
  useEffect(() => {
    const myId = localPlayer?.id;
    for (const p of players) {
      if (alivePrev.current.get(p.id) === true && !p.alive) {
        playSfx("scream", p.id === myId ? 1 : 0.8);
      }
      alivePrev.current.set(p.id, p.alive);
    }
  }, [players, localPlayer]);

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
    // Browser autoplay gate — must run inside this click handler. unlock() arms
    // the TTS/commentary queue; initAudio() arms the SFX engine (gunshots, hit,
    // reload, scream). Without initAudio the whole playSfx path is a silent
    // no-op in MP — that's why shooting made no sound.
    getSharedAudioQueue().unlock();
    initAudio();
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
        <RenderPass />
        {/* EXACT same lighting as single-player /?game (GameScene.tsx Scene):
            sky-blue bg + atmospheric Sky + hemisphere + sun + image-based
            Environment, with the arena's original PBR materials untouched. This
            is what makes the map look identical to /?game. (Shadow maps are the
            ONE thing left off — `shadows` on this Canvas + the two MediaPipe
            webcam contexts black-screened weak GPUs; that's only contact shadows.) */}
        <color attach="background" args={["#bcd4e6"]} />
        <Sky sunPosition={[60, 18, 40]} turbidity={3} rayleigh={3} mieCoefficient={0.005} mieDirectionalG={0.7} />
        <hemisphereLight args={["#bcd4e6", "#5a4633", 0.9]} />
        <directionalLight position={[12, 18, 8]} intensity={2.2} />
        <Suspense fallback={null}>
          <Environment preset="city" />
        </Suspense>
        <Suspense fallback={null}>
          <group ref={arenaRef}>
            <Arena />
            <Scatter />
          </group>
          {/* First-person: hide our own body while alive (camera sits at the
              eye). Render it when dead so the spectator orbit sees the corpse. */}
          {joined && localPlayer && !localPlayer.alive ? (
            <AssetBoundary>
              <LocalPlayerRig player={localPlayer} />
            </AssetBoundary>
          ) : null}
          {remotePlayers.map((p) => (
            <AssetBoundary key={p.id}>
              <RemotePlayerRig player={p} localTeam={localPlayer?.team} arenaRef={arenaRef} />
            </AssetBoundary>
          ))}
          {/* First-person arms + gun (same rig single-player uses), shown only
              while alive. Tracks the camera; head bones collapsed so your own
              face never fills the screen. Boundaried: if a clip GLB fails to
              load, the arms just don't show — the scene never goes black. */}
          {joined && localPlayer?.alive ? (
            <AssetBoundary>
              <FpvArms animState={fpvAnimFor(localPlayer.animState)} />
            </AssetBoundary>
          ) : null}
          {/* Pooled muzzle flash + tracer renderer (same one single-player uses).
              Mounted always — it draws BOTH our shots and enemy shots, including
              while we're dead/spectating, so the firefight reads from any view. */}
          <Vfx />
        </Suspense>
        <CamRig localPlayer={localPlayer} />
        {joined ? (
          <>
            <VisionInputBridge driver={driver} localPlayer={localPlayer} players={players} arenaRef={arenaRef} onLockChange={setAimLocked} />
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

      {/* Crosshair — body-aim is coarse, so show where the camera points; turns
          red + "LOCKED" when aim-assist has an enemy and will bend the shot. */}
      {joined && localPlayer?.alive ? <Crosshair locked={aimLocked} /> : null}

      {/* Webcam body control (DOM overlay — owns a <video>, must be OUTSIDE the
          Canvas). Mounted only after joining so we don't grab the camera early.
          Writes useControls, which VisionInputBridge consumes. */}
      {joined ? <VisionController /> : null}

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
