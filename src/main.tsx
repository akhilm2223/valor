import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Game } from "./game/GameScene";
import { GameView } from "./game/GameView";
import { CasterDemo } from "./caster/CasterDemo";
import { CasterLive } from "./caster/CasterLive";
import { Leaderboard } from "./ui/Leaderboard";
import { SpectatorRoute } from "./spectator/SpectatorRoute";
import { JoinWall } from "./spectator/JoinWall";
import { BroadcastView } from "./broadcast/BroadcastView";
import { MultiplayerGame } from "./multiplayer/MultiplayerGame";
import { Lobby } from "./lobby/Lobby";

// Screens (lobby is the front door now):
//   /                              → Lobby — pick character, invite, Play
//   /#studio                       → Model Studio (App) — animation-only playground
//   /?game                         → full FPS — movement/hitscan/combat/HUD/bots (GameScene)
//   /?game2  or  /#game            → Akhil's arena prototype (GameView)
//   /#caster                       → Tier 1 AI caster demo against mock kill stream
//   /#caster/live                  → Phase 4 Tier 1 + Tier 2 (live STDB + LLM color)
//   /#leaderboard                  → Phase 3 live leaderboard (recent rounds from SpacetimeDB)
//   /#multiplayer                  → Phase 5 networked multiplayer (server-authoritative)
//   /#spectator                    → Phase 4 fixed-angle spectator camera (read-only)
//   /#spectator/freefly            → Phase 4 spectator with touch orbit + pinch zoom
//   /#broadcast                    → sports-style 2×2 multi-POV grid + commentary + golden vote
//   /#join                         → QR join wall (phone spectators scan to spectate)
function Root() {
  // Track the hash so Akhil's #game link still works without a full reload.
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const params = new URLSearchParams(window.location.search);
  if (params.has("game")) return <Game />;
  if (params.has("game2") || hash === "#game") return <GameView />;
  if (hash === "#caster/live") return <CasterLive />;
  if (hash === "#caster") return <CasterDemo />;
  if (hash === "#leaderboard") return <Leaderboard />;
  if (hash === "#multiplayer") return <MultiplayerGame />;
  if (hash === "#spectator" || hash === "#spectator/freefly") return <SpectatorRoute />;
  if (hash === "#broadcast") return <BroadcastView />;
  if (hash === "#join") return <JoinWall />;
  if (hash === "#studio") return <App />;
  return <Lobby />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
