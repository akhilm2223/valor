// GoldenVoteBar — top-of-screen banner shown to phone spectators when a
// Golden Gun vote is in flight. Returns null in Idle, so the mobile spectator
// layout is unaffected during normal viewing.
//
// Voting:  horizontal strip of alive-player chips. Tapping a chip calls
//          cast_golden_vote with that target's id. The currently-voted chip
//          is highlighted with a gold ring. A countdown shows seconds left.
// Reveal:  banner replaced with "🏆 <name> wins!" centered for ~5s.
//
// Lives ABOVE the existing joystick/buttons (top:0 sticky) so the player can
// still control their camera while choosing a vote.

import { useEffect, useState } from "react";
import type { ValorConnection, Player } from "../../net/Connection";
import { displayName } from "../../net/playerModel";
import type { GoldenVoteView } from "../../net/useValor";

const GOLD_BRIGHT = "#ffd277";
const GOLD_DEEP = "#a9791f";
const TEAM_A = "#7db0ff";
const TEAM_B = "#ff8a6e";

interface GoldenVoteBarProps {
  view: GoldenVoteView;
  players: Player[];
  conn: ValorConnection | null;
}

export function GoldenVoteBar({ view, players, conn }: GoldenVoteBarProps) {
  const secondsLeft = useTickingCountdown(view.endsAtMs);

  if (view.state === "Idle") return null;

  if (view.state === "Reveal") {
    const winner = players.find((p) => p.id === view.winnerId);
    return (
      <div
        style={{
          ...bannerBase,
          background:
            "linear-gradient(180deg, rgba(45,33,12,0.96) 0%, rgba(28,21,8,0.96) 100%)",
          color: GOLD_BRIGHT,
          textAlign: "center",
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: 0.4,
        }}
      >
        {winner
          ? `🏆 ${displayName(winner.name)} wins the Golden Gun!`
          : "🤷  No winner"}
      </div>
    );
  }

  // Voting
  const candidates = players
    .filter((p) => p.alive)
    .sort((a, b) => a.id - b.id);

  const cast = (targetId: number) => {
    if (!conn) return;
    conn.reducers.castGoldenVote({ targetPlayerId: targetId }).catch((e) => {
      console.warn("[mobile-spectator] cast_golden_vote failed", e);
    });
  };

  return (
    <div
      style={{
        ...bannerBase,
        background:
          "linear-gradient(180deg, rgba(45,33,12,0.94) 0%, rgba(28,21,8,0.94) 100%)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: 1.4,
            color: GOLD_BRIGHT,
            fontWeight: 800,
          }}
        >
          🟡 GOLDEN GUN VOTE
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 800,
            color: GOLD_BRIGHT,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {secondsLeft}s
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          paddingBottom: 4,
          touchAction: "pan-x",
        }}
      >
        {candidates.length === 0 ? (
          <div style={{ opacity: 0.55, fontSize: 13, padding: 6 }}>
            Waiting for living players…
          </div>
        ) : (
          candidates.map((p) => (
            <Chip
              key={p.id}
              player={p}
              voteCount={view.tally.get(p.id) ?? 0}
              isMine={view.myVoteTargetId === p.id}
              onTap={() => cast(p.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Chip({
  player,
  voteCount,
  isMine,
  onTap,
}: {
  player: Player;
  voteCount: number;
  isMine: boolean;
  onTap: () => void;
}) {
  const teamColor = player.team === 0 ? TEAM_A : TEAM_B;
  return (
    <button
      onClick={onTap}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        padding: "8px 12px",
        borderRadius: 999,
        background: isMine ? "rgba(255,210,119,0.18)" : "rgba(255,255,255,0.06)",
        border: `2px solid ${isMine ? GOLD_BRIGHT : "rgba(255,255,255,0.12)"}`,
        color: "#fff",
        font: "13px/1 system-ui, sans-serif",
        fontWeight: 600,
        cursor: "pointer",
        touchAction: "manipulation",
        pointerEvents: "auto",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: teamColor,
          boxShadow: `0 0 6px ${teamColor}`,
        }}
      />
      {displayName(player.name)}
      <span
        style={{
          marginLeft: 4,
          padding: "2px 7px",
          borderRadius: 999,
          background: voteCount > 0 ? GOLD_DEEP : "rgba(255,255,255,0.1)",
          color: voteCount > 0 ? "#fff" : "rgba(255,255,255,0.55)",
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 700,
        }}
      >
        {voteCount}
      </span>
    </button>
  );
}

// Local countdown to avoid pulling in the broadcast hook from a spectator file.
function useTickingCountdown(endsAtMs: number | null): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (endsAtMs == null) {
      setS(0);
      return;
    }
    const update = () =>
      setS(Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000)));
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [endsAtMs]);
  return s;
}

const bannerBase: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 50,
  padding: "10px 14px",
  color: "#fff",
  fontFamily: "system-ui, sans-serif",
  borderBottom: `1px solid ${GOLD_DEEP}`,
  boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
  pointerEvents: "auto",
  userSelect: "none",
};
