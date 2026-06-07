// QrJoinBadge — renders a QR code pointing at the spectator URL on the same
// origin the badge is rendered from.
//
// Drop this anywhere a phone-pointed QR is wanted:
//   • Corner badge over the caster screen (#caster/live).
//   • Corner badge in the player HUD (#multiplayer).
//   • Full-bleed standalone "scan to join" wall (#join).
//
// The encoded URL is derived from `window.location.origin` + `#spectator`, so
// the same component works without config in:
//   • local dev (`http://localhost:5175/#spectator`),
//   • Vite `--host` LAN preview (`http://192.168.1.42:5175/#spectator`),
//   • a deployed origin (whatever the prod URL ends up being).
//
// SpectatorRoute's touch detection routes phones into the mobile ghost-cam UI;
// no `?mobile=1` flag needed for real phones.

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export interface QrJoinBadgeProps {
  /** QR pixel size. Defaults to 96 — fits in a HUD corner. */
  size?: number;
  /** Caption text under the QR. Defaults to "Scan to spectate". */
  caption?: string;
  /** Optional URL override (mostly for SSR/preview). Default reads `window.location`. */
  url?: string;
  /** Wrapper style — caller controls position (corner badge vs. full-screen). */
  style?: React.CSSProperties;
  /**
   * When true, the badge is rendered for a full-screen wall display:
   * larger QR, big caption, dark backdrop. Default `false` (corner pill).
   */
  variant?: "badge" | "wall";
}

function buildSpectatorUrl(): string {
  if (typeof window === "undefined") return "";
  // Strip any existing hash/query so the QR lands cleanly on `#spectator`.
  return `${window.location.origin}/#spectator`;
}

export function QrJoinBadge({
  size,
  caption,
  url,
  style,
  variant = "badge",
}: QrJoinBadgeProps) {
  const [resolved, setResolved] = useState(url ?? "");
  useEffect(() => {
    if (url) {
      setResolved(url);
      return;
    }
    setResolved(buildSpectatorUrl());
  }, [url]);

  if (!resolved) return null;

  if (variant === "wall") {
    const wallSize = size ?? 360;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          padding: "32px 40px",
          background: "#0e1115",
          color: "#fff",
          borderRadius: 18,
          border: "1px solid rgba(255,255,255,0.08)",
          ...style,
        }}
      >
        <div
          style={{
            fontSize: 13,
            opacity: 0.6,
            letterSpacing: 1.2,
            textTransform: "uppercase",
          }}
        >
          Spectate
        </div>
        <div
          style={{
            background: "#fff",
            padding: 14,
            borderRadius: 12,
            lineHeight: 0,
          }}
        >
          <QRCodeSVG
            value={resolved}
            size={wallSize}
            bgColor="#ffffff"
            fgColor="#000000"
            level="M"
          />
        </div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>
          {caption ?? "Scan to watch live"}
        </div>
        <div
          style={{
            fontSize: 12,
            opacity: 0.5,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            wordBreak: "break-all",
            textAlign: "center",
            maxWidth: wallSize,
          }}
        >
          {resolved}
        </div>
      </div>
    );
  }

  const badgeSize = size ?? 96;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "8px 10px",
        background: "rgba(20,24,28,0.82)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 10,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        userSelect: "none",
        pointerEvents: "none",
        ...style,
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: 4,
          borderRadius: 4,
          lineHeight: 0,
        }}
      >
        <QRCodeSVG
          value={resolved}
          size={badgeSize}
          bgColor="#ffffff"
          fgColor="#000000"
          level="M"
        />
      </div>
      <div
        style={{
          color: "#fff",
          fontSize: 10,
          letterSpacing: 0.6,
          opacity: 0.85,
          fontFamily: "system-ui, sans-serif",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        {caption ?? "Scan to spectate"}
      </div>
    </div>
  );
}
