// CasterLive — Phase 4 live caster page.
//
// Same UI as CasterDemo, but the kill stream comes from the LIVE SpacetimeDB
// module (via LiveStream.ts) and the color-commentary lane (Tier 2 / Color.ts)
// runs alongside the Tier 1 barks.
//
// Route: #caster/live
// Toggling: append `?mock` to use the mock kill stream instead (handy for demo
// scratch — the Tier 1 demo still lives at #caster).
//
// Priority recap (AudioQueue uses 1=chatter, 2=notable, 3=hype):
//   • Tier 1 barks fire at p1/p2/p3 depending on the event (see Barks.ts).
//   • Tier 2 color lines fire at p1 (chatter) → barks always win.
//   • Big-event color lines (notifyBigEvent on round end) fire at p2 → still
//     preemptible by a p3 ace bark, but they hold the channel above plain
//     color.

import { useEffect, useRef, useState } from "react";
import { pickBark, renderBark } from "./Barks";
import {
  createLiveKillStream,
  type LiveStreamController,
} from "./LiveStream";
import { createMockKillStream } from "./MockMatch";
import type { KillEvent, Team } from "./MockMatch";
import { getSharedAudioQueue } from "./AudioQueue";
import { createColorCommentator, type ColorController } from "./Color";
import { connectValor, type ValorConnection } from "../net/Connection";

interface FeedEntry {
  id: number;
  kind: "kill" | "round_start" | "round_end" | "bark" | "status";
  text: string;
  ts: number;
}

function categoryForKill(e: KillEvent): string {
  if (e.isAce) return "ace";
  if (e.isDouble) return "double";
  if (e.isHeadshot) return "headshot";
  if (e.isFirstBlood) return "first_blood";
  return "kill_solo";
}

function teamLabel(t: Team): string {
  return t === "A" ? "Team A" : "Team B";
}

export function CasterLive() {
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [killCount, setKillCount] = useState(0);
  const [connStatus, setConnStatus] = useState<"connecting" | "ready" | "error" | "idle">("idle");
  const [error, setError] = useState<string | null>(null);

  // Mock fallback (for ?mock query param). Lets us drive Tier 1 + Tier 2 even
  // when no game session is running.
  const isMockMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock");

  const streamRef = useRef<LiveStreamController | null>(null);
  const colorRef = useRef<ColorController | null>(null);
  const connRef = useRef<ValorConnection | null>(null);
  const nextIdRef = useRef(1);
  const queue = getSharedAudioQueue();

  const appendFeed = (entry: Omit<FeedEntry, "id" | "ts">) => {
    setFeed((f) => {
      const next = [{ ...entry, id: nextIdRef.current++, ts: Date.now() }, ...f];
      return next.slice(0, 40);
    });
  };

  const handleKill = (e: KillEvent) => {
    setKillCount((c) => c + 1);
    appendFeed({
      kind: "kill",
      text:
        `${e.killer} → ${e.victim}` +
        (e.isHeadshot ? " (HS)" : "") +
        (e.isFirstBlood ? " (FB)" : "") +
        (e.isDouble ? " (DOUBLE)" : "") +
        (e.isAce ? " (ACE)" : ""),
    });

    const category = categoryForKill(e);
    const template = pickBark(category);
    const text = renderBark(template, {
      killer: e.killer,
      victim: e.victim,
      team: teamLabel(e.team),
    });
    const dedupeKey = `${e.killer}|${e.victim}|${Date.now()}`;
    queue.enqueue({ text, priority: template.priority, dedupeKey });
    appendFeed({ kind: "bark", text: `[p${template.priority}] ${text}` });

    // Big-event hook: ace deserves a color line on top of the bark.
    if (e.isAce) {
      colorRef.current?.notifyBigEvent(
        `${e.killer} just pulled off an ACE for ${teamLabel(e.team)}.`,
      );
    }
  };

  const handleRoundStart = () => {
    appendFeed({ kind: "round_start", text: "— round start —" });
    const template = pickBark("round_start");
    const text = renderBark(template, {});
    queue.enqueue({ text, priority: template.priority });
    appendFeed({ kind: "bark", text: `[p${template.priority}] ${text}` });
  };

  const handleRoundEnd = (winner: Team) => {
    appendFeed({ kind: "round_end", text: `— round to ${teamLabel(winner)} —` });
    const template = pickBark("round_win");
    const text = renderBark(template, { team: teamLabel(winner) });
    queue.enqueue({ text, priority: template.priority });
    appendFeed({ kind: "bark", text: `[p${template.priority}] ${text}` });

    // Tier 2 big-event line — gets the LLM to wrap up the round.
    colorRef.current?.notifyBigEvent(`${teamLabel(winner)} just won the round. Recap it.`);
  };

  useEffect(() => {
    return () => {
      streamRef.current?.stop();
      colorRef.current?.stop();
      try {
        connRef.current?.disconnect();
      } catch {
        /* noop */
      }
      queue.clear();
    };
  }, [queue]);

  const start = () => {
    queue.unlock();
    setAudioOn(true);

    if (streamRef.current) streamRef.current.stop();
    if (colorRef.current) colorRef.current.stop();

    if (isMockMode) {
      // Mock path — handy for testing the priority logic without a backend.
      streamRef.current = createMockKillStream({
        onKill: handleKill,
        onRoundStart: handleRoundStart,
        onRoundEnd: handleRoundEnd,
      });
      streamRef.current.start();
      appendFeed({ kind: "status", text: "Mock mode — synthetic kill stream" });
      setRunning(true);
      setConnStatus("idle");
      return;
    }

    // Live path — connect to SpacetimeDB, hook the live stream + color lane.
    setConnStatus("connecting");
    appendFeed({ kind: "status", text: "Connecting to SpacetimeDB…" });

    const conn = connectValor({
      onReady: () => {
        setConnStatus("ready");
        appendFeed({ kind: "status", text: "Subscription applied · live feed active" });
        streamRef.current = createLiveKillStream(conn, {
          onKill: handleKill,
          onRoundStart: handleRoundStart,
          onRoundEnd: handleRoundEnd,
        });
        streamRef.current.start();
        // Tier 2 color lane — fire-and-forget LLM, never blocks the loop.
        colorRef.current = createColorCommentator(conn, queue);
        colorRef.current.start();
      },
      onError: (err) => {
        setConnStatus("error");
        setError(err.message ?? String(err));
        appendFeed({ kind: "status", text: `Connection error: ${err.message ?? err}` });
      },
    });
    connRef.current = conn;
    setRunning(true);
  };

  const stop = () => {
    streamRef.current?.stop();
    colorRef.current?.stop();
    streamRef.current = null;
    colorRef.current = null;
    try {
      connRef.current?.disconnect();
    } catch {
      /* noop */
    }
    connRef.current = null;
    queue.clear();
    setRunning(false);
    setConnStatus("idle");
  };

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
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 26, letterSpacing: 0.5 }}>
            Valor — AI Caster (Tier 1 + Tier 2 live)
          </h1>
          <p style={{ opacity: 0.7, marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            {isMockMode
              ? "Mock kill stream (override via ?mock). Live SpacetimeDB stream disabled."
              : "Live kill stream from SpacetimeDB. Tier 1 barks fire instantly; Tier 2 LLM color " +
                "commentary fires every ~10s and is fully fire-and-forget — the game keeps " +
                "running even if the API key is missing or the network drops."}
          </p>
        </header>

        <div style={{ display: "flex", gap: 12, marginBottom: 18, alignItems: "center", flexWrap: "wrap" }}>
          {!running ? (
            <button onClick={start} style={primaryBtn}>
              Start {isMockMode ? "mock" : "live"} caster
            </button>
          ) : (
            <button onClick={stop} style={dangerBtn}>
              Stop
            </button>
          )}
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            audio: {audioOn ? "unlocked" : "locked"} · kills: {killCount} · stdb: {connStatus}
            {error ? ` (${error})` : null}
          </span>
          <a href="#" style={{ marginLeft: "auto", color: "#7db0ff", fontSize: 13 }}>
            ← back to studio
          </a>
        </div>

        <div
          style={{
            background: "#181c22",
            border: "1px solid #2a2f37",
            borderRadius: 10,
            padding: 14,
            minHeight: 360,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          {feed.length === 0 ? (
            <div style={{ opacity: 0.5 }}>Feed empty. Click Start to begin.</div>
          ) : (
            feed.map((entry) => {
              const color =
                entry.kind === "bark"
                  ? "#9be7a3"
                  : entry.kind === "round_start" || entry.kind === "round_end"
                    ? "#ffd166"
                    : entry.kind === "status"
                      ? "#7db0ff"
                      : "#fff";
              const t = new Date(entry.ts).toLocaleTimeString();
              return (
                <div key={entry.id} style={{ color, whiteSpace: "pre-wrap" }}>
                  <span style={{ opacity: 0.4, marginRight: 8 }}>{t}</span>
                  <span style={{ opacity: 0.5, marginRight: 8 }}>[{entry.kind}]</span>
                  {entry.text}
                </div>
              );
            })
          )}
        </div>

        <p style={{ marginTop: 14, opacity: 0.55, fontSize: 12, lineHeight: 1.5 }}>
          Tier 1 barks at p2/p3 always preempt Tier 2 color lines (p1). Color is async — set
          VITE_ANTHROPIC_KEY in .env.local to enable it; without the key, the game stays fully
          playable and only the LLM lane goes silent.
        </p>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "12px 22px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "#3a7bff",
  color: "#fff",
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
};

const dangerBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#ff5050",
  boxShadow: "none",
};
