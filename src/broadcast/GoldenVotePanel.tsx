// GoldenVotePanel — broadcast overlay for the spectator-driven Golden Gun
// vote. Renders nothing when the vote is Idle, so the underlying broadcast
// layout is undisturbed during normal play.
//
// Voting:  big gold-bordered card across the top of the grid area showing the
//          countdown, each alive player as a horizontal bar (vote share +
//          count), and a "N votes cast" total.
// Reveal:  same slot, replaced with a "🏆 WINNER: <name>" announcement.
//
// Read-only — never calls a reducer. The mobile spectator client is what
// actually casts votes via `cast_golden_vote`.

import type { Player } from "../net/Connection";
import type { GoldenVoteView } from "../net/useValor";
import { displayName } from "../net/playerModel";
import { useGoldenVoteCountdown } from "./useGoldenVoteCountdown";

const GOLD_BRIGHT = "#ffd277";
const GOLD_DEEP = "#a9791f";
const TEAM_A = "#7db0ff";
const TEAM_B = "#ff8a6e";

interface GoldenVotePanelProps {
  view: GoldenVoteView;
  players: Player[];
  style?: React.CSSProperties;
}

export function GoldenVotePanel({ view, players, style }: GoldenVotePanelProps) {
  const secondsLeft = useGoldenVoteCountdown(view.endsAtMs);

  if (view.state === "Idle") return null;

  if (view.state === "Reveal") {
    const winner = players.find((p) => p.id === view.winnerId);
    return (
      <RevealCard
        winnerName={winner ? displayName(winner.name) : null}
        winnerTeamColor={winner ? (winner.team === 0 ? TEAM_A : TEAM_B) : "#888"}
        style={style}
      />
    );
  }

  // Voting
  const candidates = players
    .filter((p) => p.alive)
    .sort((a, b) => a.id - b.id);

  return (
    <div
      style={{
        padding: "18px 24px",
        background: "linear-gradient(180deg, rgba(45,33,12,0.94) 0%, rgba(28,21,8,0.94) 100%)",
        border: `2px solid ${GOLD_BRIGHT}`,
        borderRadius: 14,
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        boxShadow: `0 0 28px rgba(255,210,119,0.35), 0 12px 36px rgba(0,0,0,0.6)`,
        animation: "valor-vote-pulse 1.6s ease-in-out infinite",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            letterSpacing: 0.8,
            color: GOLD_BRIGHT,
            textShadow: `0 0 12px ${GOLD_DEEP}`,
          }}
        >
          🟡 GOLDEN GUN VOTE
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 800,
            color: GOLD_BRIGHT,
            fontVariantNumeric: "tabular-nums",
            minWidth: 56,
            textAlign: "right",
          }}
        >
          {secondsLeft}s
        </div>
      </div>

      {candidates.length === 0 ? (
        <div style={{ opacity: 0.55, padding: "12px 0" }}>
          Waiting for living players…
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {candidates.map((p) => (
            <CandidateBar
              key={p.id}
              player={p}
              voteCount={view.tally.get(p.id) ?? 0}
              totalVotes={view.totalVotes}
            />
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          textAlign: "right",
          fontSize: 13,
          opacity: 0.7,
          letterSpacing: 0.4,
        }}
      >
        {view.totalVotes} {view.totalVotes === 1 ? "vote" : "votes"} cast
      </div>

      <style>{`
        @keyframes valor-vote-pulse {
          0%, 100% { box-shadow: 0 0 28px rgba(255,210,119,0.35), 0 12px 36px rgba(0,0,0,0.6); }
          50%      { box-shadow: 0 0 44px rgba(255,210,119,0.6),  0 12px 36px rgba(0,0,0,0.6); }
        }
      `}</style>
    </div>
  );
}

function CandidateBar({
  player,
  voteCount,
  totalVotes,
}: {
  player: Player;
  voteCount: number;
  totalVotes: number;
}) {
  const teamColor = player.team === 0 ? TEAM_A : TEAM_B;
  const share = totalVotes === 0 ? 0 : voteCount / totalVotes;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr 44px",
        gap: 12,
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: teamColor,
            boxShadow: `0 0 8px ${teamColor}`,
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 15 }}>
          {displayName(player.name)}
        </span>
      </div>
      <div
        style={{
          position: "relative",
          height: 18,
          background: "rgba(255,255,255,0.06)",
          borderRadius: 9,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${share * 100}%`,
            background: `linear-gradient(90deg, ${GOLD_DEEP}, ${GOLD_BRIGHT})`,
            transition: "width 220ms ease-out",
          }}
        />
      </div>
      <div
        style={{
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 700,
          fontSize: 15,
          color: voteCount > 0 ? GOLD_BRIGHT : "rgba(255,255,255,0.4)",
        }}
      >
        {voteCount}
      </div>
    </div>
  );
}

function RevealCard({
  winnerName,
  winnerTeamColor,
  style,
}: {
  winnerName: string | null;
  winnerTeamColor: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: "28px 32px",
        background:
          "linear-gradient(180deg, rgba(60,42,12,0.96) 0%, rgba(30,21,5,0.96) 100%)",
        border: `2px solid ${GOLD_BRIGHT}`,
        borderRadius: 14,
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        boxShadow: `0 0 44px rgba(255,210,119,0.55), 0 12px 36px rgba(0,0,0,0.6)`,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 16,
          letterSpacing: 2,
          textTransform: "uppercase",
          opacity: 0.75,
          color: GOLD_BRIGHT,
        }}
      >
        Golden Gun Awarded
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 40,
          fontWeight: 900,
          letterSpacing: 0.4,
        }}
      >
        {winnerName ? (
          <>
            🏆{" "}
            <span style={{ color: winnerTeamColor }}>{winnerName}</span>
          </>
        ) : (
          "🤷  No winner"
        )}
      </div>
    </div>
  );
}
