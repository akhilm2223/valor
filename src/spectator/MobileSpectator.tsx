// MobileSpectator — phone-first ghost-cam spectator view.
//
// Mounts at `#spectator` on touch devices (and via `?mobile=1` for desktop QA;
// the branching lives in SpectatorRoute). Re-uses CasterCam's `SpectatorScene`
// for the world + player capsules. Adds:
//   • A virtual joystick (XZ translate) + up/down buttons (Y translate).
//   • Prev/next player follow cycling.
//   • A `spectator_join` / `spectator_leave` lifecycle around the existing
//     STDB connection. The Spectator row carries only identity + joined_at, so
//     player clients have nothing extra to render — invisible by design.
//
// Read-only — never calls `join`, `submit_input`, `fire`, etc. Smoke-test
// invariant: zero rows added to `shots` or `commentary` during a session.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { useValorConnection, usePlayers } from "../net/useValor";
import { SpectatorScene } from "./CasterCam";
import { MobileControls } from "./mobile/MobileControls";
import { RotateHint } from "./mobile/RotateHint";
import {
  useMobileGhostCam,
  type JoystickVec,
  type GhostCamRefs,
} from "./mobile/useMobileGhostCam";
import { displayName } from "../net/playerModel";
import type { Player } from "../net/Connection";

function GhostCamRig(refs: GhostCamRefs) {
  useMobileGhostCam(refs);
  return null;
}

// SwipeCapture — invisible full-screen pointer surface that sits BELOW the
// joystick/buttons in the DOM stacking order (rendered before MobileControls).
// Drags on empty space accumulate (dx, dy) pixel deltas into yaw/pitch refs,
// which the camera hook drains each frame to rotate the view. Joystick +
// buttons take their own pointer captures, so this only sees the "rest of
// screen."
function SwipeCapture({
  yawDeltaPxRef,
  pitchDeltaPxRef,
}: {
  yawDeltaPxRef: React.MutableRefObject<number>;
  pitchDeltaPxRef: React.MutableRefObject<number>;
}) {
  const activeRef = useRef<{ id: number; lastX: number; lastY: number } | null>(
    null,
  );

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeRef.current !== null) return;
    activeRef.current = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = activeRef.current;
    if (!cur || cur.id !== e.pointerId) return;
    yawDeltaPxRef.current += e.clientX - cur.lastX;
    pitchDeltaPxRef.current += e.clientY - cur.lastY;
    cur.lastX = e.clientX;
    cur.lastY = e.clientY;
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeRef.current?.id !== e.pointerId) return;
    activeRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      style={{
        position: "absolute",
        inset: 0,
        touchAction: "none",
        pointerEvents: "auto",
        background: "transparent",
        // Below MobileControls in source order → MobileControls (joystick +
        // buttons) win for hits that fall on them. Inputs that fall through
        // MobileControls (pointerEvents:none on its container) hit us here.
      }}
    />
  );
}

export function MobileSpectator() {
  const { conn, status, error } = useValorConnection();
  const players = usePlayers(conn);

  // Portrait detection — we tell the user to rotate. matchMedia is the most
  // reliable signal across iOS Safari + Android Chrome. We fall back to
  // window.inner* if matchMedia is missing.
  const [isPortrait, setIsPortrait] = useState(() => {
    if (typeof window === "undefined") return false;
    if (window.matchMedia) {
      return window.matchMedia("(orientation: portrait)").matches;
    }
    return window.innerHeight > window.innerWidth;
  });
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = (e: MediaQueryListEvent) => setIsPortrait(e.matches);
    // Modern browsers use addEventListener; old WebKit needs addListener.
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  // iOS Safari detection (excluding Chrome on iOS, which uses CriOS UA).
  // Used to surface an "Add to Home Screen" tip in the rotate overlay.
  const isIosSafari = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua);
    const isSafari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    // Also: standalone mode (already added to home screen) shouldn't show tip.
    const standalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches;
    return isIos && isSafari && !standalone;
  }, []);

  // Inputs piped to the per-frame ghost-cam loop via refs — mutating these
  // doesn't re-render React or re-install the useFrame loop.
  const joystickRef = useRef<JoystickVec>({ x: 0, y: 0 });
  const vyRef = useRef<number>(0);
  const yawDeltaPxRef = useRef<number>(0);
  const pitchDeltaPxRef = useRef<number>(0);
  const followTargetIdRef = useRef<number | null>(null);
  const playersRef = useRef<Player[]>([]);

  // Mirror the live players array into a ref so the per-frame follow lookup
  // doesn't depend on closures.
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // The button-label needs React state. Keep it in sync with the ref.
  const [followedId, setFollowedId] = useState<number | null>(null);
  const setFollowed = useCallback((id: number | null) => {
    followTargetIdRef.current = id;
    setFollowedId(id);
  }, []);

  // Lock the experience to the phone: on the first user gesture, try to
  // (a) enter fullscreen (hides browser chrome / URL bar),
  // (b) lock screen orientation to landscape — the 3D arena reads better wide,
  // (c) acquire a screen wake lock so the phone doesn't dim mid-watch.
  // Each is best-effort: iOS Safari rejects most of these silently (it only
  // grants fullscreen on user-initiated video, and orientation lock requires
  // fullscreen first). Android Chrome honors all three.
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let armed = true;

    const lockEverything = async () => {
      if (!armed) return;
      armed = false;
      // 1. fullscreen
      try {
        const el = document.documentElement as HTMLElement & {
          webkitRequestFullscreen?: () => Promise<void>;
        };
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      } catch {
        /* iOS Safari refuses outside <video>; ignore */
      }
      // 2. orientation lock (must happen AFTER fullscreen on most browsers)
      try {
        const so = screen.orientation as ScreenOrientation & {
          lock?: (o: string) => Promise<void>;
        };
        if (so?.lock) await so.lock("landscape");
      } catch {
        /* iOS doesn't support this in Safari */
      }
      // 3. wake lock — keep screen on for the watching session.
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch {
        /* needs a secure context + supported browser */
      }
    };

    const onFirstInteraction = () => {
      void lockEverything();
      window.removeEventListener("pointerdown", onFirstInteraction);
      window.removeEventListener("touchstart", onFirstInteraction);
    };
    window.addEventListener("pointerdown", onFirstInteraction, { once: true });
    window.addEventListener("touchstart", onFirstInteraction, { once: true });

    // Re-acquire wake lock when the tab regains visibility.
    const onVisChange = async () => {
      if (document.visibilityState === "visible" && !wakeLock) {
        try {
          if ("wakeLock" in navigator) {
            wakeLock = await navigator.wakeLock.request("screen");
          }
        } catch {
          /* noop */
        }
      }
    };
    document.addEventListener("visibilitychange", onVisChange);

    return () => {
      armed = false;
      window.removeEventListener("pointerdown", onFirstInteraction);
      window.removeEventListener("touchstart", onFirstInteraction);
      document.removeEventListener("visibilitychange", onVisChange);
      try {
        wakeLock?.release();
      } catch {
        /* noop */
      }
      try {
        if (document.fullscreenElement && document.exitFullscreen) {
          void document.exitFullscreen();
        }
      } catch {
        /* noop */
      }
    };
  }, []);

  // Anonymous-but-counted: register on connect, deregister on unmount. The
  // `on_disconnect` hook is the safety net for tab-close.
  useEffect(() => {
    if (!conn || status !== "ready") return;
    // Reducer calls return Promises — wire .catch() so rejections (e.g. the
    // server hasn't been republished yet so the reducer doesn't exist) surface
    // as warnings instead of unhandled errors. The Spectator row failing to
    // write doesn't affect any other read-only subscription.
    conn.reducers.spectatorJoin({}).catch((e) => {
      console.warn(
        "[mobile-spectator] spectator_join failed (server may not have new reducers yet)",
        e,
      );
    });
    return () => {
      try {
        conn.reducers.spectatorLeave({}).catch(() => {
          /* socket may already be torn down */
        });
      } catch {
        /* synchronous throw if conn is already disposed */
      }
    };
  }, [conn, status]);

  // If the followed player dies, advance to the next alive one (cycle by id).
  const aliveSorted = useMemo(
    () => [...players].filter((p) => p.alive).sort((a, b) => a.id - b.id),
    [players],
  );
  useEffect(() => {
    if (followedId === null) return;
    const cur = players.find((p) => p.id === followedId);
    if (cur && cur.alive) return;
    // Locked player gone or dead — pick the next alive by id.
    if (aliveSorted.length === 0) {
      setFollowed(null);
      return;
    }
    const next =
      aliveSorted.find((p) => p.id > followedId) ?? aliveSorted[0];
    setFollowed(next.id);
  }, [followedId, players, aliveSorted, setFollowed]);

  // Cycle includes "Free fly" (null) as an explicit stop, so prev from the
  // first player wraps back to free-fly instead of jumping to the last.
  // Sequence: [null, p0.id, p1.id, ..., pN.id, null, ...]
  const cycle = useMemo<(number | null)[]>(
    () => [null, ...aliveSorted.map((p) => p.id)],
    [aliveSorted],
  );

  const onPrev = useCallback(() => {
    if (cycle.length <= 1) return; // only free-fly, nothing to cycle
    const i = cycle.indexOf(followedId);
    const next = cycle[(i - 1 + cycle.length) % cycle.length];
    setFollowed(next);
  }, [cycle, followedId, setFollowed]);

  const onNext = useCallback(() => {
    if (cycle.length <= 1) return;
    const i = cycle.indexOf(followedId);
    const next = cycle[(i + 1) % cycle.length];
    setFollowed(next);
  }, [cycle, followedId, setFollowed]);

  const onClearFollow = useCallback(() => setFollowed(null), [setFollowed]);

  const onJoystick = useCallback(
    (vec: JoystickVec) => {
      joystickRef.current = vec;
      // A deliberate stick push clears the follow lock so the spectator feels
      // in control immediately.
      if (followTargetIdRef.current !== null && Math.hypot(vec.x, vec.y) > 0.15) {
        setFollowed(null);
      }
    },
    [setFollowed],
  );

  const onVyChange = useCallback((vy: number) => {
    vyRef.current = vy;
  }, []);

  const followedPlayer =
    followedId !== null ? players.find((p) => p.id === followedId) : undefined;
  const followLabel = followedPlayer
    ? `Following ${displayName(followedPlayer.name)}`
    : "Free fly";

  return (
    <div style={{ position: "absolute", inset: 0, background: "#0e1115" }}>
      <Canvas
        shadows
        camera={{ position: [0, 18, 22], fov: 55, near: 0.1, far: 400 }}
        dpr={[1, 1.5]}
      >
        <SpectatorScene players={players} />
        <GhostCamRig
          joystickRef={joystickRef}
          vyRef={vyRef}
          yawDeltaPxRef={yawDeltaPxRef}
          pitchDeltaPxRef={pitchDeltaPxRef}
          followTargetIdRef={followTargetIdRef}
          playersRef={playersRef}
        />
      </Canvas>

      <SwipeCapture
        yawDeltaPxRef={yawDeltaPxRef}
        pitchDeltaPxRef={pitchDeltaPxRef}
      />

      <MobileControls
        onJoystick={onJoystick}
        onVyChange={onVyChange}
        onPrev={onPrev}
        onNext={onNext}
        onClearFollow={onClearFollow}
        followLabel={followLabel}
      />

      <div
        style={{
          position: "absolute",
          bottom: 12,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "6px 12px",
          background: "rgba(20,24,28,0.7)",
          color: "#fff",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.12)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          font: "11px/1 system-ui, sans-serif",
          letterSpacing: 0.4,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        SPECTATOR ·{" "}
        {status === "ready"
          ? `live · ${aliveSorted.length} alive`
          : status === "error"
            ? `error: ${error?.message ?? "unknown"}`
            : "connecting…"}
      </div>

      {/* Portrait → "rotate your phone" overlay. Last child so it stacks on
          top of all the controls and the canvas. */}
      <RotateHint show={isPortrait} iosSafari={isIosSafari} />
    </div>
  );
}
