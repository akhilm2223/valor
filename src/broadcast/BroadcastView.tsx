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

import { useEffect, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { useGameMatch, usePlayers, useValorConnection } from "../net/useValor";
import { QrJoinBadge } from "../spectator/QrJoinBadge";
import { BroadcastErrorBanner } from "./BroadcastErrorBanner";
import { CommentaryRail } from "./CommentaryRail";
import { MatchScoreBar } from "./MatchScoreBar";
import { PovTile, PovTileView } from "./PovTile";
import { useFeaturedPlayers } from "./useFeaturedPlayers";
import type { Player } from "../net/Connection";

const SLOT_COUNT = 4;

export function BroadcastView() {
  const { conn, status, error } = useValorConnection();
  const players = usePlayers(conn);
  const match = useGameMatch(conn);

  // Director: pick 4 alive ids; reshuffle only on death.
  const featuredIds = useFeaturedPlayers(players, SLOT_COUNT);

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
        <MatchScoreBar match={match} />
      </div>

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
