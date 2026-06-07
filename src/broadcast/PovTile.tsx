// PovTile / PovTileView — split into a DOM cell + an R3F View.
//
// drei's <View track={ref}> renders a camera pass inside the host <Canvas>
// into the bounding rect of a DOM element. So we need TWO pieces sharing the
// same ref:
//   • <PovTile> — DOM cell with the badge/placeholder. Owns the ref.
//   • <PovTileView> — R3F-side: camera + follow-cam driver + SpectatorScene
//     wrapped in <View track={ref}>. Must live inside the Canvas.
// The parent (BroadcastView) creates the ref and threads it to both.
//
// Empty branch: if playerId is null, no <View> is mounted on the R3F side and
// the DOM cell shows a "Waiting for player N" placeholder.

import { View, PerspectiveCamera } from "@react-three/drei";
import { useMemo, type MutableRefObject, type RefObject } from "react";
import { SpectatorScene } from "../spectator/CasterCam";
import { displayName } from "../net/playerModel";
import { useFollowCam } from "./useFollowCam";
import type { Player } from "../net/Connection";

const TEAM_A = "#7db0ff";
const TEAM_B = "#ff8a6e";

// ---- DOM cell ----------------------------------------------------------

interface PovTileProps {
  slotIndex: number;
  playerId: number | null;
  players: Player[];
  tileRef: RefObject<HTMLDivElement | null>;
}

export function PovTile({ slotIndex, playerId, players, tileRef }: PovTileProps) {
  const player = useMemo(
    () => (playerId == null ? null : players.find((p) => p.id === playerId) ?? null),
    [players, playerId],
  );
  const teamColor = player ? (player.team === 0 ? TEAM_A : TEAM_B) : "#666";
  const name = player ? displayName(player.name) : null;

  return (
    <div
      ref={tileRef}
      style={{
        position: "relative",
        background: playerId == null ? "#11151b" : "transparent",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {playerId == null ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            opacity: 0.4,
            fontFamily: "system-ui, sans-serif",
            fontSize: 14,
            letterSpacing: 0.4,
          }}
        >
          Waiting for player {slotIndex + 1}
        </div>
      ) : null}

      {player ? (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            background: "rgba(20,24,28,0.78)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 999,
            color: "#fff",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: 0.3,
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: teamColor,
              boxShadow: `0 0 8px ${teamColor}`,
            }}
          />
          {name}
          <span
            style={{
              fontSize: 11,
              opacity: 0.7,
              fontWeight: 500,
              marginLeft: 4,
            }}
          >
            HP {player.health} · K {player.kills}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---- R3F side ----------------------------------------------------------

interface PovTileViewProps {
  playerId: number;
  players: Player[];
  playersRef: MutableRefObject<Player[]>;
  tileRef: RefObject<HTMLDivElement | null>;
}

export function PovTileView({ playerId, players, playersRef, tileRef }: PovTileViewProps) {
  return (
    // drei's View accepts a ref to any HTMLElement; the broadcast tiles are
    // divs, so HTMLDivElement is fine.
    <View track={tileRef as RefObject<HTMLElement>}>
      <PerspectiveCamera makeDefault fov={62} near={0.1} far={400} />
      <FollowCamDriver playerId={playerId} playersRef={playersRef} />
      <SpectatorScene players={players} />
    </View>
  );
}

function FollowCamDriver({
  playerId,
  playersRef,
}: {
  playerId: number;
  playersRef: MutableRefObject<Player[]>;
}) {
  useFollowCam({ playerId, playersRef });
  return null;
}
