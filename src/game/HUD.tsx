// ─────────────────────────────────────────────────────────────────────────
// HUD.tsx — the player's heads-up display. A pure DOM overlay that sits OVER
// the R3F Canvas (never inside it) and reads live discrete state from useGame.
//
// Everything here is read-only and pointer-transparent: `pointerEvents: none`
// on the root so clicks/locks fall straight through to the game canvas. We
// select NARROWLY from the store (the local entity, the event ring) to keep
// re-renders cheap — 60fps transforms never live here, so the HUD only wakes
// when health/ammo/alive/events actually change.
//
// Five elements: crosshair (center), health (bottom-left), ammo (bottom-right),
// hitmarker (flashes over the crosshair on our own `hit` events), and killfeed
// (top-right stack of recent `kill` events). All guard for the local entity
// being briefly undefined during spawn.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_ID, MAX_HEALTH, MAG_SIZE, type GameEvent } from "./contracts";
import { useGame } from "./stores";

// Short, friendly label for an entity id: our own id reads "you".
function label(id: string): string {
  return id === LOCAL_ID ? "you" : id;
}

// Health bar colour ramp: green (full) → amber (mid) → red (low).
function healthColor(frac: number): string {
  if (frac > 0.5) return "#3ddc84"; // green
  if (frac > 0.25) return "#ffb300"; // amber
  return "#ff4d4d"; // red
}

const HITMARKER_MS = 120; // hitmarker flash + fade duration

export function HUD() {
  // Narrow selections: only the local player's discrete state + the event ring.
  const local = useGame((s) => s.entities[LOCAL_ID]);
  const events = useGame((s) => s.events);

  const health = local?.health ?? 0;
  const alive = local?.alive ?? false;
  const ammo = local?.ammo ?? 0;
  const reloading = local?.reloading ?? false;
  const healthFrac = Math.max(0, Math.min(1, health / MAX_HEALTH));

  // ── Hitmarker ──────────────────────────────────────────────────────────
  // Flash when a NEW `hit` event authored by us (by === LOCAL_ID) appears.
  // We detect "new" by comparing the latest such event's `t` against a ref.
  const lastHitT = useRef(0);
  const [hitAt, setHitAt] = useState(0); // wall-clock ms of the active flash, 0 = none

  // Newest hit event we caused, derived cheaply from the ring buffer.
  const latestOwnHitT = useMemo(() => {
    let t = 0;
    for (const e of events) {
      if (e.kind === "hit" && e.by === LOCAL_ID && e.t > t) t = e.t;
    }
    return t;
  }, [events]);

  useEffect(() => {
    if (latestOwnHitT > lastHitT.current) {
      lastHitT.current = latestOwnHitT;
      const now = performance.now();
      setHitAt(now);
      const id = window.setTimeout(() => setHitAt(0), HITMARKER_MS);
      return () => window.clearTimeout(id);
    }
  }, [latestOwnHitT]);

  // ── Killfeed ───────────────────────────────────────────────────────────
  // Most-recent-first, capped to a few rows, older entries faded.
  const kills = useMemo(() => {
    const out: Array<{ ev: GameEvent; key: number }> = [];
    for (let i = events.length - 1; i >= 0 && out.length < 5; i--) {
      const e = events[i];
      if (e.kind === "kill") out.push({ ev: e, key: i });
    }
    return out;
  }, [events]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        font: "13px/1.4 system-ui, sans-serif",
        color: "#fff",
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      {/* ── Crosshair + hitmarker (dead center) ── */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 0,
          height: 0,
        }}
      >
        <Crosshair dim={!alive} />
        {hitAt !== 0 && <Hitmarker />}
      </div>

      {/* ── Killfeed (top-right) ── */}
      <div
        style={{
          position: "absolute",
          top: 14,
          right: 14,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
        }}
      >
        {kills.map(({ ev, key }, i) => (
          <div
            key={key}
            style={{
              padding: "4px 9px",
              borderRadius: 6,
              background: "rgba(16,18,22,0.78)",
              backdropFilter: "blur(6px)",
              fontVariantNumeric: "tabular-nums",
              opacity: 1 - i * 0.18, // fade older entries
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ fontWeight: 600 }}>{label(ev.by)}</span>
            <span style={{ opacity: 0.55, margin: "0 6px" }}>▸</span>
            <span style={{ opacity: 0.85 }}>{label(ev.on)}</span>
          </div>
        ))}
      </div>

      {/* ── Health (bottom-left) ── */}
      <div
        style={{
          position: "absolute",
          left: 18,
          bottom: 18,
          width: 220,
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(16,18,22,0.78)",
          backdropFilter: "blur(6px)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 6,
            letterSpacing: 0.4,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>HEALTH</span>
          {alive ? (
            <span
              style={{
                fontSize: 18,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: healthColor(healthFrac),
              }}
            >
              {Math.max(0, Math.round(health))}
            </span>
          ) : (
            <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 2, opacity: 0.5 }}>DEAD</span>
          )}
        </div>
        <div
          style={{
            height: 8,
            borderRadius: 4,
            background: "rgba(255,255,255,0.12)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${healthFrac * 100}%`,
              background: alive ? healthColor(healthFrac) : "rgba(255,255,255,0.25)",
              borderRadius: 4,
              transition: "width 120ms linear, background 200ms linear",
            }}
          />
        </div>
      </div>

      {/* ── Ammo (bottom-right) ── */}
      <div
        style={{
          position: "absolute",
          right: 18,
          bottom: 18,
          minWidth: 130,
          padding: "10px 14px",
          borderRadius: 10,
          background: "rgba(16,18,22,0.78)",
          backdropFilter: "blur(6px)",
          textAlign: "right",
          opacity: reloading ? 0.55 : 1,
          transition: "opacity 150ms linear",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, letterSpacing: 0.4, marginBottom: 2 }}>
          {reloading ? "RELOADING" : "AMMO"}
        </div>
        <div style={{ fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
          <span style={{ fontSize: 34, fontWeight: 800 }}>{ammo}</span>
          <span style={{ fontSize: 18, fontWeight: 600, opacity: 0.5 }}> / {MAG_SIZE}</span>
        </div>
      </div>
    </div>
  );
}

// ── Crosshair — four lines + a center dot, drawn purely in CSS. ───────────
function Crosshair({ dim }: { dim: boolean }) {
  const color = dim ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.85)";
  const gap = 4; // px from center to each arm
  const len = 7; // arm length
  const thick = 2; // arm thickness
  const arm = (style: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    background: color,
    boxShadow: "0 0 2px rgba(0,0,0,0.8)",
    ...style,
  });
  return (
    <div style={{ position: "absolute", left: 0, top: 0, transform: "translate(-50%, -50%)" }}>
      {/* center dot */}
      <div
        style={arm({
          left: -1,
          top: -1,
          width: 2,
          height: 2,
          borderRadius: 1,
        })}
      />
      {/* up */}
      <div style={arm({ left: -thick / 2, top: -gap - len, width: thick, height: len })} />
      {/* down */}
      <div style={arm({ left: -thick / 2, top: gap, width: thick, height: len })} />
      {/* left */}
      <div style={arm({ top: -thick / 2, left: -gap - len, height: thick, width: len })} />
      {/* right */}
      <div style={arm({ top: -thick / 2, left: gap, height: thick, width: len })} />
    </div>
  );
}

// ── Hitmarker — an expanding/fading "✕" flashed over the crosshair. ───────
function Hitmarker() {
  const stroke: React.CSSProperties = {
    position: "absolute",
    left: -1,
    top: -7,
    width: 2,
    height: 14,
    background: "#fff",
    boxShadow: "0 0 3px rgba(0,0,0,0.9)",
    borderRadius: 1,
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transform: "translate(-50%, -50%)",
        animation: "none",
      }}
    >
      {/* The two strokes of the ✕, rotated; the wrapper scales up + fades via key remount. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "center",
          // expand-and-fade: starts slightly large/bright, settles — short timer
          // unmounts it after HITMARKER_MS, so a CSS keyframe isn't required.
          animation: `hud-hit ${HITMARKER_MS}ms ease-out forwards`,
        }}
      >
        <div style={{ ...stroke, transform: "rotate(45deg)" }} />
        <div style={{ ...stroke, transform: "rotate(-45deg)" }} />
      </div>
      {/* Scoped keyframes for the hitmarker pop. Injected once via this style tag. */}
      <style>{`@keyframes hud-hit{0%{transform:scale(1.6);opacity:1}100%{transform:scale(0.9);opacity:0}}`}</style>
    </div>
  );
}
