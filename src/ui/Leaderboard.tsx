// Leaderboard.tsx — Phase 3 read-only persistent leaderboard.
//
// Subscribes to the `leaderboard` table via the shared connection wrapper
// (src/net/Connection.ts) and renders the most recent 10 rounds:
//   - round number
//   - winning-team badge (Team A / Team B)
//   - total kills (Team A · Team B)
//   - relative time ("3 min ago")
//
// Style follows GameView.tsx's overlay style: dark glass-card, semi-transparent
// background + backdrop blur + white text. Drop-in route at `#leaderboard`.
//
// Phase 4 (caster) can reuse this for the post-match recap screen.
//
// Phase 5 swap: connection acquisition + row subscription bookkeeping now live
// in src/net/useValor.ts. Visible behavior unchanged.

import { useEffect, useMemo, useState } from "react";
import type { LeaderboardRow } from "../net/Connection";
import { useValorConnection, useLeaderboardRows } from "../net/useValor";

// "3 min ago" / "just now" / "1 h ago" — small, no library.
function relativeTime(date: Date, now: number): string {
  const sec = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const days = Math.floor(hr / 24);
  return `${days} d ago`;
}

// Tick `now` every 30s so relative-time strings stay fresh without thrashing renders.
function useTickingClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function Leaderboard() {
  const { conn, status, error } = useValorConnection();
  const rows = useLeaderboardRows(conn, 10);
  const now = useTickingClock();
  const headerText = useMemo(() => {
    if (status === "connecting") return "Connecting to SpacetimeDB…";
    if (status === "error") return `Connection error: ${error?.message ?? "unknown"}`;
    if (rows.length === 0) return "No rounds played yet";
    return `${rows.length} recent round${rows.length === 1 ? "" : "s"}`;
  }, [status, error, rows.length]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0e1115",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 26, letterSpacing: 0.5 }}>Valor — Leaderboard</h1>
          <span style={{ opacity: 0.6, fontSize: 13 }}>{headerText}</span>
          <a href="#" style={{ marginLeft: "auto", color: "#7db0ff", fontSize: 13 }}>
            ← Back to studio
          </a>
        </header>

        <div
          style={{
            position: "relative",
            background: "rgba(20,24,28,0.82)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
            padding: 18,
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
          }}
        >
          {rows.length === 0 ? (
            <div style={{ opacity: 0.6, padding: "16px 0", textAlign: "center" }}>
              {status === "ready" ? "Waiting for the first round to end…" : headerText}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ opacity: 0.55, textAlign: "left", fontWeight: 600 }}>
                  <th style={th}>Round</th>
                  <th style={th}>Winner</th>
                  <th style={{ ...th, textAlign: "right" }}>Team A kills</th>
                  <th style={{ ...th, textAlign: "right" }}>Team B kills</th>
                  <th style={{ ...th, textAlign: "right" }}>Ended</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <LeaderRow key={String(r.id)} row={r} now={now} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p style={{ marginTop: 14, opacity: 0.5, fontSize: 12, lineHeight: 1.5 }}>
          Rows are written by the server tick when a team is wiped or the round timer hits 0.
          Cumulative kills are summed across the players table per team.
        </p>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.7,
};

const td: React.CSSProperties = {
  padding: "10px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.05)",
  fontVariantNumeric: "tabular-nums",
};

function LeaderRow({ row, now }: { row: LeaderboardRow; now: number }) {
  const winnerIsA = row.winningTeam === 0;
  const winnerColor = winnerIsA ? "#7db0ff" : "#ff8a6e";
  const winnerLabel = winnerIsA ? "Team A" : "Team B";

  return (
    <tr>
      <td style={td}>#{row.matchRound}</td>
      <td style={td}>
        <span
          style={{
            display: "inline-block",
            padding: "3px 9px",
            borderRadius: 999,
            fontWeight: 600,
            background: winnerIsA ? "rgba(125,176,255,0.18)" : "rgba(255,138,110,0.18)",
            color: winnerColor,
            border: `1px solid ${winnerColor}55`,
            fontSize: 12,
          }}
        >
          {winnerLabel}
        </span>
      </td>
      <td style={{ ...td, textAlign: "right" }}>{row.teamAKills.toString()}</td>
      <td style={{ ...td, textAlign: "right" }}>{row.teamBKills.toString()}</td>
      <td style={{ ...td, textAlign: "right", opacity: 0.7 }}>
        {relativeTime(row.playedAt.toDate(), now)}
      </td>
    </tr>
  );
}
