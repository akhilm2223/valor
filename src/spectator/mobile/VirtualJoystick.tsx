// VirtualJoystick — pointer-event-driven thumbstick.
//
// 120px circle base + 50px knob that follows the pointer within radius. Emits
// `{ x, y }` ∈ [-1, 1]² via `onChange` on every movement and on release.
//
// Pointer Events instead of touch+mouse-specific handlers so the same code
// path works for finger, mouse (?mobile=1 desktop QA), Apple Pencil. The div
// uses `touchAction: "none"` to suppress browser scroll/zoom during a drag.
//
// Convention: y is screen-down-positive (CSS coords), which matches what the
// ghost cam hook expects — atan2(jx, -jy) treats "push up on stick" as
// "move in world -Z."

import { useCallback, useRef, useState } from "react";

const SIZE = 120;
const KNOB = 50;
const RADIUS = (SIZE - KNOB) / 2; // max travel from center

export interface VirtualJoystickProps {
  onChange: (vec: { x: number; y: number }) => void;
  /** Optional override; defaults to bottom-left inset. */
  style?: React.CSSProperties;
}

export function VirtualJoystick({ onChange, style }: VirtualJoystickProps) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const emit = useCallback(
    (kx: number, ky: number) => {
      // Normalize knob pixel offset to [-1, 1].
      setKnob({ x: kx, y: ky });
      onChange({ x: kx / RADIUS, y: ky / RADIUS });
    },
    [onChange],
  );

  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== null) return;
      activePointerRef.current = e.pointerId;
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      const rect = baseRef.current!.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const { x, y } = clampToRadius(dx, dy);
      emit(x, y);
    },
    [emit],
  );

  const handleMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== e.pointerId) return;
      const rect = baseRef.current!.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const { x, y } = clampToRadius(dx, dy);
      emit(x, y);
    },
    [emit],
  );

  const handleUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== e.pointerId) return;
      activePointerRef.current = null;
      try {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      emit(0, 0);
    },
    [emit],
  );

  return (
    <div
      ref={baseRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      style={{
        width: SIZE,
        height: SIZE,
        borderRadius: "50%",
        background: "rgba(20,24,28,0.55)",
        border: "1px solid rgba(255,255,255,0.18)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        position: "relative",
        touchAction: "none",
        userSelect: "none",
        pointerEvents: "auto",
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: KNOB,
          height: KNOB,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.85)",
          border: "1px solid rgba(0,0,0,0.2)",
          boxShadow: "0 4px 10px rgba(0,0,0,0.4)",
          transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
          transition:
            activePointerRef.current === null ? "transform 120ms ease-out" : "none",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function clampToRadius(dx: number, dy: number): { x: number; y: number } {
  const mag = Math.hypot(dx, dy);
  if (mag <= RADIUS) return { x: dx, y: dy };
  const k = RADIUS / mag;
  return { x: dx * k, y: dy * k };
}
