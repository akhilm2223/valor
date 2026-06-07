// BroadcastErrorBanner — bottom-of-screen status pill for the broadcast view.
// Mirrors the spectator's connection-state badge: shown when status is not
// "ready", hidden otherwise so it doesn't clutter the broadcast layout.

import type { ConnStatus } from "../net/useValor";

interface BroadcastErrorBannerProps {
  status: ConnStatus;
  error: Error | null;
}

export function BroadcastErrorBanner({ status, error }: BroadcastErrorBannerProps) {
  if (status === "ready") return null;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: 18,
        transform: "translateX(-50%)",
        padding: "8px 16px",
        background: "rgba(20,24,28,0.85)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 999,
        color: "#fff",
        font: "12px/1 system-ui, sans-serif",
        letterSpacing: 0.5,
        zIndex: 5,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      BROADCAST ·{" "}
      {status === "connecting"
        ? "connecting…"
        : status === "error"
          ? `error: ${error?.message ?? "unknown"}`
          : status}
    </div>
  );
}
