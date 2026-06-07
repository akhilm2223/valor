// MatchScoreBar — top bar for the broadcast view.
//
// Big projection-friendly score readout: round + state on the left, the two
// team scores in the center, timer on the right. Pure DOM, no canvas. Lifted
// from MatchHud in src/spectator/CasterCam.tsx:230-254 with bigger type for
// wall display.

import type { GameMatch } from "../net/Connection";

const TEAM_A = "#7db0ff";
const TEAM_B = "#ff8a6e";

interface MatchScoreBarProps {
  match: GameMatch | undefined;
  style?: React.CSSProperties;
}

export function MatchScoreBar({ match, style }: MatchScoreBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 28,
        padding: "10px 28px",
        background:
          "linear-gradient(180deg, rgba(20,24,28,0.95) 0%, rgba(20,24,28,0.78) 100%)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        userSelect: "none",
        ...style,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 180 }}>
        <span
          style={{
            fontSize: 11,
            letterSpacing: 1.6,
            opacity: 0.55,
            fontWeight: 700,
            textTransform: "uppercase",
          }}
        >
          {match ? `Round ${match.round}` : "Standby"}
        </span>
        <span
          style={{
            fontSize: 13,
            opacity: 0.75,
            fontWeight: 600,
            letterSpacing: 0.4,
          }}
        >
          {match ? match.state.tag.toUpperCase() : "No match"}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: 22,
          fontWeight: 800,
        }}
      >
        <span style={{ color: TEAM_A, fontSize: 36 }}>
          {match ? match.scoreA : 0}
        </span>
        <span
          style={{
            opacity: 0.5,
            fontSize: 16,
            letterSpacing: 1.5,
            fontWeight: 700,
          }}
        >
          VS
        </span>
        <span style={{ color: TEAM_B, fontSize: 36 }}>
          {match ? match.scoreB : 0}
        </span>
      </div>

      <div
        style={{
          minWidth: 180,
          textAlign: "right",
          fontSize: 15,
          opacity: 0.75,
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {match
          ? `${Math.round(Number(match.roundTimerMs) / 1000)}s left`
          : "—"}
      </div>
    </div>
  );
}
