// USAGE (Akhil, hook this into GameView.tsx — DO NOT have me modify it):
//
//   import { useSpectatorCam, SpectatorOverlay } from "./SpectatorCam";
//   import type { Player, GameMatch } from "../net/Connection";
//
//   // Inside the R3F scene (anywhere with useFrame access — e.g. <Player /> sibling)
//   function CamRig({ localPlayer }: { localPlayer: Player | undefined }) {
//     useSpectatorCam(localPlayer);
//     return null;
//   }
//
//   // In the DOM overlay (NOT inside the Canvas), to show the respawn timer:
//   <SpectatorOverlay localPlayer={localPlayer} match={gameMatch} />
//
// Pre-conditions:
//   • The R3F Canvas must already exist (uses useFrame + useThree).
//   • `localPlayer` is the row matching the local Identity from conn.db.players.
//     Pass `undefined` while connecting and the hook does nothing.
//   • `match` is the singleton game_match row (id=0).
//
// Behavior:
//   • While localPlayer.alive === false (or after the round/match ends), the
//     camera detaches from PlayerController and free-flies above the arena,
//     rotating slowly so the spectator gets a wide read.
//   • As soon as alive flips back to true, the cam stops driving itself and
//     returns control to PlayerController (which writes camera.position/quat
//     every physics step anyway). The hook simply stops being a writer.
//   • SpectatorOverlay shows "You're spectating — next round in Ns" using the
//     match state + round_end_timestamp + the same 5s cooldown the server uses.
//
// Why a separate file: the live FPS (GameView/GameScene) shouldn't grow more
// branches around camera ownership. This file is the one place that knows about
// the spectator transition. When Phase 4's body-input lands, the same hook
// keeps working without changes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { Player, GameMatch } from "../net/Connection";

// Where the camera flies to when spectating: above the arena looking at origin.
const SPECTATOR_VANTAGE: [number, number, number] = [0, 12, 14];
const SPECTATOR_LOOK_AT: [number, number, number] = [0, 0, 0];
// How fast (in lerp factor / sec at 60fps) the camera glides to the vantage.
const LERP_RATE = 4.0;
// Slow horizontal orbit so the shot doesn't feel locked.
const ORBIT_RAD_PER_SEC = 0.15;
const ORBIT_RADIUS_XZ = Math.sqrt(SPECTATOR_VANTAGE[0] ** 2 + SPECTATOR_VANTAGE[2] ** 2);

// Server-side cooldown between RoundEnd → Live (mirrors ROUND_END_COOLDOWN_MS in server/src/lib.rs).
const ROUND_END_COOLDOWN_MS = 5_000;

/**
 * Drives the R3F default camera into a free-fly spectator orbit while the local
 * player is dead. Must be mounted INSIDE a <Canvas> (uses useFrame + useThree).
 *
 * Call from a tiny rig component:
 *   function CamRig({ localPlayer }) { useSpectatorCam(localPlayer); return null; }
 *
 * Hands control back the frame `localPlayer.alive` becomes true again — the
 * hook simply stops writing, and PlayerController's per-frame camera writes
 * resume taking effect.
 */
export function useSpectatorCam(localPlayer: Player | undefined): void {
  const camera = useThree((s) => s.camera);
  const tRef = useRef(0); // seconds since spectator started, for the slow orbit
  const lookAt = useMemo(() => new Vector3(...SPECTATOR_LOOK_AT), []);
  const target = useMemo(() => new Vector3(), []);

  useFrame((_, dtRaw) => {
    // Treat "no player row" as alive — we're still connecting; don't fight the
    // user's controls.
    const spectating = localPlayer != null && localPlayer.alive === false;
    if (!spectating) {
      tRef.current = 0;
      return;
    }

    const dt = Math.min(dtRaw, 0.1);
    tRef.current += dt;

    // Slow orbit around Y. Use the configured vantage's XZ as the start point so
    // the camera doesn't snap on entry.
    const angle = Math.atan2(SPECTATOR_VANTAGE[2], SPECTATOR_VANTAGE[0]) + tRef.current * ORBIT_RAD_PER_SEC;
    target.set(
      Math.cos(angle) * ORBIT_RADIUS_XZ,
      SPECTATOR_VANTAGE[1],
      Math.sin(angle) * ORBIT_RADIUS_XZ,
    );

    // Frame-rate-independent exponential approach to the target.
    const alpha = 1 - Math.exp(-LERP_RATE * dt);
    camera.position.lerp(target, alpha);
    camera.lookAt(lookAt);
  });
}

// ---------------------------------------------------------------------------
// SpectatorOverlay — DOM overlay shown while the local player is dead.
// Mount alongside HUD (NOT inside the Canvas). It pulls round state from the
// already-subscribed game_match row.
// ---------------------------------------------------------------------------

export interface SpectatorOverlayProps {
  localPlayer: Player | undefined;
  match: GameMatch | undefined;
}

export function SpectatorOverlay({ localPlayer, match }: SpectatorOverlayProps) {
  const spectating = localPlayer != null && localPlayer.alive === false;
  const [now, setNow] = useState(() => Date.now());

  // 4Hz clock — enough for a smooth countdown without burning frames.
  useEffect(() => {
    if (!spectating) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [spectating]);

  if (!spectating) return null;

  const secsToRestart = computeRestartSeconds(match, now);
  const message =
    match?.state.tag === "RoundEnd" && secsToRestart != null
      ? `You're spectating — next round in ${secsToRestart}s`
      : match?.state.tag === "MatchEnd"
        ? "You're spectating — match over"
        : match?.state.tag === "Live"
          ? "You're spectating — wait for the next round"
          : "You're spectating";

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        padding: "14px 22px",
        background: "rgba(20,24,28,0.82)",
        color: "#fff",
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        font: "600 16px/1.3 system-ui, sans-serif",
        textAlign: "center",
        pointerEvents: "none",
        userSelect: "none",
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4, letterSpacing: 0.6 }}>SPECTATING</div>
      <div>{message}</div>
    </div>
  );
}

// Returns seconds (whole) remaining until the next round auto-starts, or null
// if we can't compute it (e.g. match isn't in RoundEnd / no timestamp yet).
function computeRestartSeconds(match: GameMatch | undefined, now: number): number | null {
  if (!match) return null;
  if (match.state.tag !== "RoundEnd") return null;
  const endMs = Number(match.roundEndTimestamp.toMillis());
  if (!Number.isFinite(endMs) || endMs <= 0) return null;
  const remainingMs = ROUND_END_COOLDOWN_MS - (now - endMs);
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}
