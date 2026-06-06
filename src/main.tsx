import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Game } from "./game/GameScene";

// Route by query flag: `?game` loads the playable FPS, anything else the studio.
// Keeps the studio (character/gun/animation viewer) reachable and default.
const isGame = new URLSearchParams(window.location.search).has("game");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isGame ? <Game /> : <App />}</React.StrictMode>
);
