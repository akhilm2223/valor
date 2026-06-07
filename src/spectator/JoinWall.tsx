// JoinWall — full-screen "scan to spectate" display at #join.
//
// Meant to be projected on a wall / second monitor / event poster screen so
// guests at the event scan the QR with their phone and land in the mobile
// spectator. Standalone — no STDB connection, no audio, no game state.

import { QrJoinBadge } from "./QrJoinBadge";

export function JoinWall() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(ellipse at center, #1c2331 0%, #0a0d12 70%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: 14,
            letterSpacing: 6,
            opacity: 0.55,
            marginBottom: 18,
            textTransform: "uppercase",
          }}
        >
          Valor — Live
        </div>
        <QrJoinBadge variant="wall" size={360} caption="Scan to watch live" />
      </div>
    </div>
  );
}
