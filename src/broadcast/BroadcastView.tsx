// BroadcastView — sports-style multi-POV display at #broadcast.
//
// Layout:
//   ┌───────────────────────────────────┐
//   │            MatchScoreBar          │  ← 64px
//   ├────────────────────┬──────────────┤
//   │  ┌─POV0─┐ ┌─POV1─┐ │              │
//   │  └──────┘ └──────┘ │  Commentary  │
//   │  ┌─POV2─┐ ┌─POV3─┐ │     rail     │
//   │  └──────┘ └──────┘ │  340px wide  │
//   └────────────────────┴──────────────┘
//
// A single full-screen <Canvas> sits underneath the DOM grid at zIndex:0,
// pointerEvents:none. Each <PovTile> is a positioned div whose ref a drei
// <View> tracks — drei reads each ref's bounding rect every frame and
// renders that view's camera pass into the canvas at that rect. The 4 cells
// share one canvas → 4 camera passes over a shared scene, ~4× the per-frame
// cost of a single CasterCam but one WebGL context instead of four.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import {
  useGameMatch,
  useGoldenVote,
  usePlayers,
  useValorConnection,
} from "../net/useValor";
import { QrJoinBadge } from "../spectator/QrJoinBadge";
import { BroadcastErrorBanner } from "./BroadcastErrorBanner";
import { CommentaryRail } from "./CommentaryRail";
import { GoldenVotePanel } from "./GoldenVotePanel";
import { MatchScoreBar } from "./MatchScoreBar";
import { PovTile, PovTileView } from "./PovTile";
import { useFeaturedPlayers } from "./useFeaturedPlayers";
import { useGoldenVoteCountdown } from "./useGoldenVoteCountdown";
import type { Player } from "../net/Connection";

const SLOT_COUNT = 4;

export function BroadcastView() {
  const { conn, status, error, identity } = useValorConnection();
  const players = usePlayers(conn);
  const match = useGameMatch(conn);
  const goldenVote = useGoldenVote(conn, identity, match);
  const secondsLeftForButton = useGoldenVoteCountdown(goldenVote.endsAtMs);

  // Director: pick 4 alive ids; reshuffle only on death.
  const featuredIds = useFeaturedPlayers(players, SLOT_COUNT);

  // Operator: trigger the vote from the broadcast itself. Match must be Live
  // and no vote currently in flight. Error rejections (e.g. "vote only during
  // Live") are swallowed with a console.warn — the button will simply remain
  // visible and the operator can retry when the match enters Live.
  const onStartVote = useCallback(() => {
    if (!conn) return;
    conn.reducers.startGoldenVote({}).catch((e) => {
      console.warn("[broadcast] start_golden_vote rejected:", e);
    });
  }, [conn]);

  // The button is shown whenever no vote is in flight — the server enforces
  // "must be Live" and rejects gracefully if not. This keeps the button
  // visible as a teaching affordance even between rounds.
  const operatorSlot =
    goldenVote.state === "Voting" ? (
      <span style={statusPillStyle}>
        VOTING · {secondsLeftForButton}s
      </span>
    ) : goldenVote.state === "Reveal" ? (
      <span style={statusPillStyle}>WINNER REVEAL</span>
    ) : (
      <button onClick={onStartVote} style={goldButtonStyle}>
        🟡 Start Golden Vote
      </button>
    );

  // Players ref kept fresh for the per-frame follow-cam loops. Refs avoid
  // re-installing useFrame on every render.
  const playersRef = useRef<Player[]>([]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // One DOM ref per tile, shared between the DOM cell (PovTile) and the R3F
  // View block (PovTileView). Created once and reused so drei <View> stays
  // bound to the same DOM rect across renders.
  const tileRefs = useMemo(
    () =>
      Array.from({ length: SLOT_COUNT }, () =>
        ({ current: null } as React.RefObject<HTMLDivElement | null>),
      ),
    [],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0b0d10",
        color: "#fff",
        display: "grid",
        gridTemplateColumns: "1fr 340px",
        gridTemplateRows: "64px 1fr",
        gridTemplateAreas: `"score score" "grid rail"`,
        overflow: "hidden",
      }}
    >
      {/* Shared canvas underneath the layout. The drei <View> blocks
          inside each <PovTile> register against this canvas and render
          into the tile's tracked DOM rect. */}
      <Canvas
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
        eventSource={document.body}
        eventPrefix="client"
      >
        {featuredIds.map((id, i) =>
          id == null ? null : (
            <PovTileView
              key={`view-${i}`}
              playerId={id}
              playersRef={playersRef}
              players={players}
              tileRef={tileRefs[i]}
            />
          ),
        )}
      </Canvas>

      <div style={{ gridArea: "score", zIndex: 2 }}>
        <MatchScoreBar match={match} right={operatorSlot} />
      </div>

      {/* Golden Gun vote overlay — pinned across the top of the grid area
          while active, nothing rendered when Idle. Positioned absolute over
          the grid so the 2×2 doesn't reflow when vote starts/ends. */}
      {goldenVote.state !== "Idle" ? (
        <div
          style={{
            position: "absolute",
            top: 76,
            left: 16,
            right: 356,
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <GoldenVotePanel view={goldenVote} players={players} />
        </div>
      ) : null}

      <div
        style={{
          gridArea: "grid",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: 8,
          padding: 8,
          zIndex: 1,
        }}
      >
        {featuredIds.map((id, i) => (
          <PovTile
            key={`tile-${i}`}
            slotIndex={i}
            playerId={id}
            players={players}
            tileRef={tileRefs[i]}
          />
        ))}
      </div>

      {/* Rail: commentary fills the top, "scan to spectate" QR pinned to the
          bottom so phone-watchers can join during a live broadcast. */}
      <div
        style={{
          gridArea: "rail",
          zIndex: 2,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderLeft: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <CommentaryRail
          conn={conn}
          style={{ flex: 1, overflowY: "auto", minHeight: 0 }}
        />
        <div
          style={{
            padding: "16px 18px",
            borderTop: "1px solid rgba(255,255,255,0.07)",
            background: "#0d1218",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <QrJoinBadge size={120} caption="Scan to spectate" />
        </div>
      </div>

      <BroadcastErrorBanner status={status} error={error} />
    </div>
  );
}

const goldButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 999,
  border: "1px solid #ffd277",
  background: "linear-gradient(180deg, #f5b942 0%, #a9791f 100%)",
  color: "#1a1408",
  font: "13px/1 system-ui, sans-serif",
  fontWeight: 800,
  letterSpacing: 0.3,
  cursor: "pointer",
  boxShadow: "0 4px 14px rgba(255,210,119,0.35)",
};

const statusPillStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid rgba(255,210,119,0.45)",
  background: "rgba(255,210,119,0.12)",
  color: "#ffd277",
  font: "12px/1 system-ui, sans-serif",
  fontWeight: 800,
  letterSpacing: 0.6,
};
