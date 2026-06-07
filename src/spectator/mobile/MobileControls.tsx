// MobileControls — DOM overlay above the R3F canvas.
//
// Layout:
//   • Bottom-left: virtual joystick (translate the ghost in XZ plane).
//   • Bottom-right: stacked Up / Down buttons (translate Y while held).
//   • Top-center: Prev / Next player follow + a label of the currently locked
//     player (or "Free fly").
//
// Pointer-events discipline: the container itself is pointerEvents:none so the
// canvas behind receives clicks where the controls aren't. Each interactive
// child element re-enables pointerEvents:auto.

import { useCallback, useRef } from "react";
import { VirtualJoystick } from "./VirtualJoystick";

export interface MobileControlsProps {
  onJoystick: (vec: { x: number; y: number }) => void;
  onVyChange: (vy: number) => void; // -1 | 0 | +1
  onPrev: () => void;
  onNext: () => void;
  onClearFollow: () => void;
  followLabel: string; // e.g. "Free fly" or player name
}

export function MobileControls({
  onJoystick,
  onVyChange,
  onPrev,
  onNext,
  onClearFollow,
  followLabel,
}: MobileControlsProps) {
  // Track held buttons by pointer id so multi-touch doesn't drop releases.
  const upPointerRef = useRef<number | null>(null);
  const downPointerRef = useRef<number | null>(null);

  const handleVyDown = useCallback(
    (which: "up" | "down") => (e: React.PointerEvent<HTMLButtonElement>) => {
      const slot = which === "up" ? upPointerRef : downPointerRef;
      if (slot.current !== null) return;
      slot.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      onVyChange(which === "up" ? 1 : -1);
    },
    [onVyChange],
  );

  const handleVyUp = useCallback(
    (which: "up" | "down") => (e: React.PointerEvent<HTMLButtonElement>) => {
      const slot = which === "up" ? upPointerRef : downPointerRef;
      if (slot.current !== e.pointerId) return;
      slot.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      onVyChange(0);
    },
    [onVyChange],
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {/* Top-center: follow strip */}
      <div
        style={{
          position: "absolute",
          top: 14,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "8px 10px",
          background: "rgba(20,24,28,0.75)",
          color: "#fff",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.12)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          font: "13px/1 system-ui, sans-serif",
        }}
      >
        <CircleButton label="◀" onTap={onPrev} aria="Previous player" />
        <button
          onClick={onClearFollow}
          style={{
            ...labelBtnStyle,
            minWidth: 120,
          }}
        >
          {followLabel}
        </button>
        <CircleButton label="▶" onTap={onNext} aria="Next player" />
      </div>

      {/* Bottom-left: joystick */}
      <div
        style={{
          position: "absolute",
          left: 18,
          bottom: 22,
          pointerEvents: "auto",
        }}
      >
        <VirtualJoystick onChange={onJoystick} />
      </div>

      {/* Bottom-right: up/down stack */}
      <div
        style={{
          position: "absolute",
          right: 18,
          bottom: 22,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <button
          onPointerDown={handleVyDown("up")}
          onPointerUp={handleVyUp("up")}
          onPointerCancel={handleVyUp("up")}
          onPointerLeave={handleVyUp("up")}
          aria-label="Rise"
          style={vyBtnStyle}
        >
          ▲
        </button>
        <button
          onPointerDown={handleVyDown("down")}
          onPointerUp={handleVyUp("down")}
          onPointerCancel={handleVyUp("down")}
          onPointerLeave={handleVyUp("down")}
          aria-label="Descend"
          style={vyBtnStyle}
        >
          ▼
        </button>
      </div>
    </div>
  );
}

function CircleButton({
  label,
  onTap,
  aria,
}: {
  label: string;
  onTap: () => void;
  aria: string;
}) {
  return (
    <button
      onClick={onTap}
      aria-label={aria}
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        border: "1px solid rgba(255,255,255,0.18)",
        background: "rgba(255,255,255,0.12)",
        color: "#fff",
        font: "16px/1 system-ui, sans-serif",
        cursor: "pointer",
        pointerEvents: "auto",
        touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );
}

const vyBtnStyle: React.CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: "50%",
  background: "rgba(20,24,28,0.65)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.18)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  font: "20px/1 system-ui, sans-serif",
  pointerEvents: "auto",
  touchAction: "none",
  userSelect: "none",
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
};

const labelBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#fff",
  border: "none",
  font: "13px/1 system-ui, sans-serif",
  padding: "6px 10px",
  borderRadius: 6,
  cursor: "pointer",
  pointerEvents: "auto",
  textAlign: "center",
};
