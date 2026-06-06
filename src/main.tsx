import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Game } from "./game/GameScene";
import { GameView } from "./game/GameView";
import { CasterDemo } from "./caster/CasterDemo";

// Four screens (studio stays the default, animation-only):
//   /                  → Model Studio (App)
//   /?game             → full FPS — movement/hitscan/combat/HUD/bots (GameScene)
//   /?game2  or  /#game → Akhil's arena prototype (GameView)
//   /#caster           → Tier 1 AI caster demo against mock kill stream
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
  if (hash === "#caster") return <CasterDemo />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
