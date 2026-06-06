// ─────────────────────────────────────────────────────────────────────────
// VisionController.tsx — webcam → game input via MediaPipe.
// Writes the SAME `useControls` store the keyboard/mouse does, so no game code
// changes (the input seam from Game-Logic-Deep-Dive §5).
//
//   FIRE  — off-hand OPEN palm → CLOSED fist = one shot (latch: reopen to
//           re-fire, so a held fist is one shot, not auto-fire).  [Gesture]
//   MOVE  — torso LEAN: lean left/right = strafe, lean fwd/back = walk.
//           Read from hip-centered worldLandmarks → distance-invariant.  [Pose]
//
// Two models share one webcam: GestureRecognizer every frame (fire needs
// responsiveness), PoseLandmarker throttled to ~18 Hz (torso is slow).
// Mount as a DOM overlay (it owns a <video>), NOT inside the Canvas.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { FilesetResolver, GestureRecognizer, PoseLandmarker } from "@mediapipe/tasks-vision";
import { useControls } from "./stores";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const GESTURE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// fire thresholds (Game-Logic-Deep-Dive §5)
const FIST_ON = 0.6; // score to count a closed fist
const OPEN_ON = 0.5; // score to re-arm (open palm)
const COOLDOWN_MS = 150; // min spacing between shots

// movement: torso lean, normalized by torso length (Schmitt hysteresis).
const POSE_HZ = 18; // throttle pose inference
const CALIB_MS = 2000; // capture neutral pose over the first ~2s
const STRAFE_ON = 0.15, STRAFE_OFF = 0.1; // lateral lean (shoulder.x − hip.x)/torso
const FWD_ON = 0.18, FWD_OFF = 0.12; // depth lean (shoulder.z − hip.z)/torso
// Sign conventions: lean toward your RIGHT → strafeRight; lean FORWARD → moveForward.
// If a direction comes out reversed during testing, flip the matching sign below.
const LAT_SIGN = 1; // multiply lateral delta so +ve = user's right
const FWD_SIGN = -1; // multiply depth delta so +ve = leaning toward camera (forward)

// BlazePose landmark indices
const L_SH = 11, R_SH = 12, L_HP = 23, R_HP = 24;
const mid = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => ({
  x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2,
});

export function VisionController() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("starting camera…");
  const [gesture, setGesture] = useState("");
  const [move, setMove] = useState("");

  useEffect(() => {
    let gestureRec: GestureRecognizer | null = null;
    let poseRec: PoseLandmarker | null = null;
    let raf = 0;
    let stream: MediaStream | null = null;
    let lastVideoTime = -1;
    let ts = 0;
    let dead = false;

    // fire FSM
    let armed = true; // ready to fire (hand has been open)
    let lastShot = -1e9;

    // movement state
    let lastPoseAt = -1e9;
    let calibStart = -1; // set on first pose
    let nSamples = 0, sumLat = 0, sumFwd = 0; // calibration accumulators
    let neutralLat = 0, neutralFwd = 0, calibrated = false;
    // held booleans (Schmitt) — only write to store on change
    let sl = false, sr = false, mf = false, mb = false;

    (async () => {
      try {
        const video = videoRef.current!;
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        video.srcObject = stream;
        await video.play();

        const fileset = await FilesetResolver.forVisionTasks(WASM);
        const mkGesture = (delegate: "GPU" | "CPU") =>
          GestureRecognizer.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: GESTURE_MODEL, delegate },
            runningMode: "VIDEO",
            numHands: 2,
          });
        const mkPose = (delegate: "GPU" | "CPU") =>
          PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
          });
        gestureRec = await mkGesture("GPU").catch(() => mkGesture("CPU"));
        poseRec = await mkPose("GPU").catch(() => mkPose("CPU"));

        setStatus("calibrating — stand neutral…");

        const loop = () => {
          if (dead) return;
          if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
            lastVideoTime = video.currentTime;
            ts = Math.max(performance.now(), ts + 1);
            const now = performance.now();

            // ── FIRE: gesture every frame ──────────────────────────────
            const g = gestureRec!.recognizeForVideo(video, ts);
            let fist = false, open = false;
            for (const hand of g.gestures) {
              const c = hand[0];
              if (!c) continue;
              if (c.categoryName === "Closed_Fist" && c.score > FIST_ON) fist = true;
              if (c.categoryName === "Open_Palm" && c.score > OPEN_ON) open = true;
            }
            if (open) armed = true;
            if (fist && armed && now - lastShot > COOLDOWN_MS) {
              armed = false; // latch: reopen before next shot
              lastShot = now;
              useControls.setState({ firePressed: true });
            }
            setGesture(fist ? "✊ FIRE" : open ? "✋ ready" : "—");

            // ── MOVE: pose throttled ~18Hz ─────────────────────────────
            if (now - lastPoseAt > 1000 / POSE_HZ) {
              lastPoseAt = now;
              const p = poseRec!.detectForVideo(video, ts);
              const w = p.worldLandmarks?.[0];
              if (w && w[L_SH] && w[R_SH] && w[L_HP] && w[R_HP]) {
                const shMid = mid(w[L_SH], w[R_SH]);
                const hpMid = mid(w[L_HP], w[R_HP]);
                // torso length (meters) → body-size & distance invariant scale
                const dx = shMid.x - hpMid.x, dy = shMid.y - hpMid.y, dz = shMid.z - hpMid.z;
                const torso = Math.hypot(dx, dy, dz) || 1;
                const lat = (shMid.x - hpMid.x) / torso;
                const fwd = (shMid.z - hpMid.z) / torso;

                if (!calibrated) {
                  if (calibStart < 0) calibStart = now;
                  // discard first 0.5s (model warm-up), average the rest
                  if (now - calibStart > 500) { nSamples++; sumLat += lat; sumFwd += fwd; }
                  if (now - calibStart > CALIB_MS && nSamples > 0) {
                    neutralLat = sumLat / nSamples;
                    neutralFwd = sumFwd / nSamples;
                    calibrated = true;
                    setStatus("✋ open→✊ fist = FIRE · lean to move");
                  }
                } else {
                  const dLat = LAT_SIGN * (lat - neutralLat);
                  const dFwd = FWD_SIGN * (fwd - neutralFwd);
                  // Schmitt: enter at ON, release at OFF (prevents boundary flicker)
                  sr = dLat > STRAFE_ON ? true : dLat < STRAFE_OFF ? false : sr;
                  sl = -dLat > STRAFE_ON ? true : -dLat < STRAFE_OFF ? false : sl;
                  mf = dFwd > FWD_ON ? true : dFwd < FWD_OFF ? false : mf;
                  mb = -dFwd > FWD_ON ? true : -dFwd < FWD_OFF ? false : mb;
                  useControls.setState({
                    strafeLeft: sl, strafeRight: sr, moveForward: mf, moveBack: mb,
                  });
                  setMove(
                    [mf && "↑", mb && "↓", sl && "←", sr && "→"].filter(Boolean).join(" ") || "·"
                  );
                }
              }
            }
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        setStatus("camera/vision error — " + (e as Error).message);
      }
    })();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      gestureRec?.close();
      poseRec?.close();
      stream?.getTracks().forEach((t) => t.stop());
      // release any held movement so the player doesn't keep walking
      useControls.setState({ strafeLeft: false, strafeRight: false, moveForward: false, moveBack: false });
    };
  }, []);

  return (
    <div style={{ position: "absolute", bottom: 12, left: 12, font: "12px system-ui", color: "#fff", userSelect: "none" }}>
      <video
        ref={videoRef}
        muted
        playsInline
        style={{ width: 176, height: 132, transform: "scaleX(-1)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.2)", background: "#000", display: "block" }}
      />
      <div style={{ marginTop: 6, background: "rgba(20,24,28,0.8)", padding: "5px 8px", borderRadius: 7, display: "inline-block" }}>
        🖐️ {status}
        {gesture && <b style={{ color: gesture.startsWith("✊") ? "#ff7a7a" : "#7dffa0", marginLeft: 6 }}>· {gesture}</b>}
        {move && <b style={{ color: "#7db4ff", marginLeft: 6 }}>· {move}</b>}
      </div>
    </div>
  );
}
