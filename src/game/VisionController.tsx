// ─────────────────────────────────────────────────────────────────────────
// VisionController.tsx — webcam → game input via MediaPipe.
// Writes the SAME `useControls` store the keyboard/mouse does, so no game code
// changes (the input seam from Game-Logic-Deep-Dive §5).
//
//   MOVE   — LEFT-hand FINGER COUNT (all movement, works at a desk):
//            fist(0)=STOP · 1=forward · 2=back · 3=turn right · 4=turn left.
//            1/2 walk; 3/4 feed yawDelta (turn). No pitch.  [Gesture]
//   FIRE   — RIGHT-hand CLOSED fist = shoot (open = stop); auto-repeats at the
//            weapon's cadence while held. That's all the right hand does.  [Gesture]
//   AIM    — vertical aim is handled by AIM ASSIST in Weapon.tsx (the shot bends
//            onto the nearest enemy within a cone), so no up/down look is needed.
//   SCOPE  — exactly ONE eye CLOSED (a wink) = aim/zoom in; both eyes open =
//            zoom out. Sets controls.aiming; Weapon lerps the FOV.  [Face]
//   (Hand roles are split by which SIDE of the frame the hand is on, NOT by
//    MediaPipe handedness which is unreliable here; see MIRRORED if inverted.)
//
// Two models share one webcam: GestureRecognizer every frame (hands = fire +
// move), FaceLandmarker ~15 Hz (eyes = scope). Mount as a DOM overlay (it owns a
// <video>), NOT inside the Canvas.
// ─────────────────────────────────────────────────────────────────────────

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";
import { useControls } from "./stores";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";
const GESTURE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// fire thresholds (Game-Logic-Deep-Dive §5)
const FIST_ON = 0.6; // score to count a closed fist
const COOLDOWN_MS = 150; // min spacing between auto-fire shots (Weapon caps the real rate)

// scope (aim): one eye CLOSED = zoom in; both open = zoom out. Read from
// FaceLandmarker blendshapes "eyeBlinkLeft/Right" (1 = fully closed). We require
// exactly ONE eye shut (a wink) so a normal blink (both shut) doesn't scope.
const FACE_HZ = 15; // throttle face inference
const EYE_SHUT = 0.5; // blink score that counts an eye as closed
const EYE_OPEN = 0.35; // blink score below which an eye is clearly open

// LEFT-hand finger count = ALL movement (no torso/lean — works at a desk):
//   0 (fist) = STOP · 1 = LEFT · 2 = RIGHT · 3 = FORWARD · 4 = BACK.
// Deterministic (no tilt, no neutral). We count extended fingers ourselves from
// the landmarks; a finger is "up" when its TIP is higher (smaller y) than its
// PIP joint, so it reads cleanly with the hand held upright (fingers up).
// Re-map if you'd prefer different counts.
const FINGER_FWD = 1; // move forward
const FINGER_BACK = 2; // move backward
const FINGER_TURN_R = 3; // turn the view RIGHT (yaw)
const FINGER_TURN_L = 4; // turn the view LEFT  (yaw)
const COUNT_CONFIRM = 3; // frames a finger count must persist before it's applied (debounce)

// TURN (yaw) — discrete + reliable — comes from the LEFT-hand finger count above
// (3 = right, 4 = left), fed to yawDelta each frame at a fixed rate. There is no
// up/down look — vertical aim is handled by AIM ASSIST in Weapon.tsx instead.
const TURN_RATE = 1.6; // rad/s view yaw while a turn count is held (~92°/s)
const TURN_SIGN = 1; // flip if left/right are reversed

// START GATE: before play, both OPEN palms must sit in their on-screen boxes for
// CALIB_HOLD_MS. This calibrates each hand's neutral (so the look isn't wild at
// the cold start) and gives a clear "ready" ritual. Boxes are in RAW (unmirrored)
// frame coords; the user's right hand lives in the left half (x<0.5).
const R_BOX = { x0: 0.06, x1: 0.40, y0: 0.28, y1: 0.82 }; // user's RIGHT hand (look)
const L_BOX = { x0: 0.60, x1: 0.94, y0: 0.28, y1: 0.82 }; // user's LEFT hand (move)
const CALIB_HOLD_MS = 1200; // hold both palms in the boxes this long to start
const CALIB_OPEN = 0.45; // Open_Palm score to count as "all fingers out"
const inBox = (b: { x0: number; x1: number; y0: number; y1: number }, x: number, y: number) =>
  x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

// Two-hand roles: RIGHT hand = fire (fist), LEFT hand = move (finger count).
//
// We do NOT use MediaPipe's `handedness` label — it's assigned assuming a
// mirrored selfie image and is unreliable for a raw webcam feed. Instead we split
// by which SIDE of the frame the hand is on, which is deterministic: getUserMedia
// gives an UNMIRRORED frame, so the user's right hand sits on the LEFT half
// (wrist x < 0.5) and the left hand on the right half. Works for one hand or two.
//
// If your camera mirrors its feed (some do), the sides invert — set MIRRORED.
const MIRRORED = false; // true if the webcam feed is already mirrored
const WRIST = 0; // landmark index of the wrist (hand center proxy)

// Count extended fingers (index/middle/ring/pinky) on a 21-pt hand. A finger is
// "up" when its TIP sits above (smaller y) its PIP joint. Thumb is ignored — it's
// orientation-dependent. Returns 0–4. Needs the hand held upright.
type Pt = { x: number; y: number };
function countFingers(lm: Pt[]): number {
  if (!lm || lm.length < 21) return 0;
  let n = 0;
  if (lm[8].y < lm[6].y) n++; // index
  if (lm[12].y < lm[10].y) n++; // middle
  if (lm[16].y < lm[14].y) n++; // ring
  if (lm[20].y < lm[18].y) n++; // pinky
  return n;
}

export function VisionController() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("starting camera…");
  const [gesture, setGesture] = useState("");
  // Start-gate UI: both open palms in their boxes for CALIB_HOLD_MS to begin.
  const [calib, setCalib] = useState({ done: false, rIn: false, lIn: false, prog: 0 });
  const calibDoneRef = useRef(false);

  useEffect(() => {
    let gestureRec: GestureRecognizer | null = null;
    let faceRec: FaceLandmarker | null = null;
    let raf = 0;
    let stream: MediaStream | null = null;
    let lastVideoTime = -1;
    let ts = 0;
    let dead = false;

    // fire pacing (auto-fire while the right fist is held)
    let lastShot = -1e9;

    // movement state — fwd/back booleans, only written to the store on change
    let mf = false, mb = false;
    // left-hand finger-count debounce: only apply a count that holds steady
    let candCount = -1, candStreak = 0, heldCount = -1;
    // per-frame yaw timing (turn feed)
    let lastLookAt = -1;
    // scope (eyes) state
    let lastFaceAt = -1e9;
    let aiming = false; // held: one eye closed → zoom in
    // start-gate hold timer
    let calibHoldStart = -1;

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
        const mkFace = (delegate: "GPU" | "CPU") =>
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true, // eye-blink scores live here
          });
        gestureRec = await mkGesture("GPU").catch(() => mkGesture("CPU"));
        faceRec = await mkFace("GPU").catch(() => mkFace("CPU"));

        setStatus("LEFT hand: ✊0 stop · 1 fwd · 2 back · 3 turn R · 4 turn L · RIGHT ✊ = fire · wink scope");

        const loop = () => {
          if (dead) return;
          const now = performance.now();

          // ── TURN (yaw, every frame): left-hand 3 = right, 4 = left ─────────
          // Feed yawDelta each render frame at a fixed rate, scaled by real dt so
          // it's frame-rate independent. No pitch — aim assist handles vertical.
          if (calibDoneRef.current && lastLookAt >= 0) {
            const turn = heldCount === FINGER_TURN_R ? 1 : heldCount === FINGER_TURN_L ? -1 : 0;
            if (turn !== 0) {
              const dt = Math.min((now - lastLookAt) / 1000, 0.05);
              const c = useControls.getState();
              useControls.setState({ yawDelta: c.yawDelta + TURN_SIGN * turn * TURN_RATE * dt });
            }
          }
          lastLookAt = now;

          if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
            lastVideoTime = video.currentTime;
            ts = Math.max(now, ts + 1);

            const g = gestureRec!.recognizeForVideo(video, ts);

            // ── START GATE: hold both OPEN palms in their boxes to begin ──────
            if (!calibDoneRef.current) {
              let rIn = false, lIn = false;
              for (let i = 0; i < g.gestures.length; i++) {
                const c = g.gestures[i]?.[0];
                const lm = g.landmarks?.[i];
                if (!c || !lm || !lm[WRIST]) continue;
                const x = lm[WRIST].x, y = lm[WRIST].y;
                const open = c.categoryName === "Open_Palm" && c.score > CALIB_OPEN;
                if (!open) continue;
                const isUserRight = MIRRORED ? x > 0.5 : x < 0.5;
                if (isUserRight && inBox(R_BOX, x, y)) rIn = true;
                else if (!isUserRight && inBox(L_BOX, x, y)) lIn = true;
              }
              let prog = 0;
              if (rIn && lIn) {
                if (calibHoldStart < 0) calibHoldStart = now;
                prog = Math.min(1, (now - calibHoldStart) / CALIB_HOLD_MS);
                if (prog >= 1) {
                  calibDoneRef.current = true; // both hands ready → go live
                  setCalib({ done: true, rIn: true, lIn: true, prog: 1 });
                }
              } else {
                calibHoldStart = -1;
              }
              if (!calibDoneRef.current) setCalib({ done: false, rIn, lIn, prog });
              raf = requestAnimationFrame(loop);
              return;
            }

            // ── RIGHT hand = FIRE (fist) · LEFT hand = MOVE (finger count) ────
            let fireFist = false, leftCount = -1; // leftCount −1 = left hand not seen
            for (let i = 0; i < g.gestures.length; i++) {
              const c = g.gestures[i]?.[0];
              const lm = g.landmarks?.[i];
              if (!c || !lm || !lm[WRIST]) continue;
              // Side of the raw (unmirrored) frame → which of the user's hands.
              const x = lm[WRIST].x; // 0 = frame-left, 1 = frame-right
              const isUserRight = MIRRORED ? x > 0.5 : x < 0.5;
              if (isUserRight) {
                // RIGHT hand only fires: a fist shoots (open = stop).
                if (c.categoryName === "Closed_Fist" && c.score > FIST_ON) fireFist = true;
              } else {
                // MOVE hand (user's left): count the extended fingers.
                leftCount = countFingers(lm as Pt[]);
              }
            }

            // Fire: AUTO while the right fist is held — keep shooting at the
            // weapon's cadence (paced by COOLDOWN_MS), independent of movement.
            // (Weapon.tsx caps the real rate, handles ammo + AIM ASSIST.)
            if (fireFist && now - lastShot > COOLDOWN_MS) {
              lastShot = now;
              useControls.setState({ firePressed: true });
            }

            // Move: debounce the finger count (it can flicker a frame), then map
            // it — 0(fist)/no-hand = stop · 1 = forward · 2 = back.
            if (leftCount >= 0) {
              if (leftCount === candCount) candStreak++;
              else { candCount = leftCount; candStreak = 1; }
              if (candStreak >= COUNT_CONFIRM) heldCount = leftCount;
            } else {
              candCount = -1; candStreak = 0; heldCount = -1; // hand gone → stop
            }
            const nmf = heldCount === FINGER_FWD;
            const nmb = heldCount === FINGER_BACK;
            if (nmf !== mf || nmb !== mb) {
              mf = nmf; mb = nmb;
              useControls.setState({ moveForward: mf, moveBack: mb, strafeLeft: false, strafeRight: false });
            }

            // ── SCOPE: face throttled ~15Hz — one eye closed = zoom in ──
            if (faceRec && now - lastFaceAt > 1000 / FACE_HZ) {
              lastFaceAt = now;
              const f = faceRec.detectForVideo(video, ts);
              const bs = f.faceBlendshapes?.[0]?.categories;
              if (bs && bs.length) {
                let blinkL = 0, blinkR = 0;
                for (const cat of bs) {
                  if (cat.categoryName === "eyeBlinkLeft") blinkL = cat.score;
                  else if (cat.categoryName === "eyeBlinkRight") blinkR = cat.score;
                }
                // Exactly ONE eye shut (a wink) — a normal blink shuts both, so
                // it won't scope. Schmitt-ish via the two thresholds.
                const lShut = blinkL > EYE_SHUT, rShut = blinkR > EYE_SHUT;
                const lOpen = blinkL < EYE_OPEN, rOpen = blinkR < EYE_OPEN;
                const wink = (lShut && rOpen) || (rShut && lOpen);
                if (wink !== aiming) {
                  aiming = wink;
                  useControls.setState({ aiming });
                }
              }
            }

            // Readout: left-hand move, right-hand look/fire, scope.
            const dir = mf ? "↑fwd" : mb ? "↓back"
              : heldCount === FINGER_TURN_R ? "turn R↱"
              : heldCount === FINGER_TURN_L ? "↰turn L"
              : heldCount === 0 ? "✊STOP" : "·";
            const rTxt = fireFist ? "✊FIRE" : "·";
            const sTxt = aiming ? " · 🔭SCOPE" : "";
            setGesture(`L ${dir} · R ${rTxt}${sTxt}`);
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
      faceRec?.close();
      stream?.getTracks().forEach((t) => t.stop());
      // release any held movement/look/aim so the player doesn't keep going
      useControls.setState({ strafeLeft: false, strafeRight: false, moveForward: false, moveBack: false, yawDelta: 0, pitchDelta: 0, aiming: false });
    };
  }, []);

  const playing = calib.done;
  // Box → CSS over the (mirrored) video. Mirror x so the box sits on the same
  // side the user sees their hand.
  const boxCss = (b: typeof R_BOX): CSSProperties => ({
    position: "absolute",
    left: `${(1 - b.x1) * 100}%`,
    top: `${b.y0 * 100}%`,
    width: `${(b.x1 - b.x0) * 100}%`,
    height: `${(b.y1 - b.y0) * 100}%`,
    borderRadius: 12,
    boxSizing: "border-box",
    pointerEvents: "none",
  });
  const tag = (on: boolean): CSSProperties => ({
    position: "absolute", top: -24, left: 0, fontSize: 13, fontWeight: 700,
    color: on ? "#57e08a" : "#fff", whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.8)",
  });

  return (
    <>
      {/* Dim the game behind the start gate */}
      {!playing && <div style={{ position: "fixed", inset: 0, background: "rgba(8,10,12,0.8)", zIndex: 30 }} />}

      <div
        style={
          playing
            ? { position: "absolute", bottom: 12, left: 12, font: "12px system-ui", color: "#fff", userSelect: "none", zIndex: 31 }
            : { position: "fixed", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, font: "14px system-ui", color: "#fff", zIndex: 31, padding: 16, boxSizing: "border-box" }
        }
      >
        {!playing && <div style={{ fontWeight: 700, fontSize: 20 }}>🖐️ Put BOTH open palms in the boxes to start</div>}

        <div style={{ position: "relative", width: playing ? 176 : "min(74vw, 660px)", aspectRatio: "4 / 3" }}>
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: "100%", height: "100%", transform: "scaleX(-1)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)", background: "#000", display: "block", objectFit: "cover" }}
          />
          {!playing && (
            <>
              <div style={{ ...boxCss(R_BOX), border: `3px ${calib.rIn ? "solid" : "dashed"} ${calib.rIn ? "#57e08a" : "rgba(255,255,255,0.55)"}`, background: calib.rIn ? "rgba(87,224,138,0.12)" : "transparent" }}>
                <span style={tag(calib.rIn)}>RIGHT ✋ — fire</span>
              </div>
              <div style={{ ...boxCss(L_BOX), border: `3px ${calib.lIn ? "solid" : "dashed"} ${calib.lIn ? "#57e08a" : "rgba(255,255,255,0.55)"}`, background: calib.lIn ? "rgba(87,224,138,0.12)" : "transparent" }}>
                <span style={tag(calib.lIn)}>LEFT ✋ — move</span>
              </div>
            </>
          )}
        </div>

        {!playing && (
          <>
            <div style={{ width: "min(74vw, 660px)", height: 12, borderRadius: 7, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
              <div style={{ width: `${Math.round(calib.prog * 100)}%`, height: "100%", background: calib.rIn && calib.lIn ? "#57e08a" : "#7db4ff", transition: "width 0.08s linear" }} />
            </div>
            <div style={{ opacity: 0.85 }}>
              {calib.rIn && calib.lIn
                ? "Hold it… keep both palms steady"
                : "Show OPEN palms (all fingers) and place each hand in its box"}
            </div>
          </>
        )}

        {playing && (
          <div style={{ marginTop: 6, background: "rgba(20,24,28,0.8)", padding: "5px 8px", borderRadius: 7, display: "inline-block" }}>
            🖐️ {status}
            {gesture && <b style={{ color: gesture.includes("FIRE") ? "#ff7a7a" : gesture.includes("STOP") ? "#ffd27a" : gesture.includes("SCOPE") ? "#7df0ff" : "#7dffa0", marginLeft: 6 }}>· {gesture}</b>}
          </div>
        )}
      </div>
    </>
  );
}
