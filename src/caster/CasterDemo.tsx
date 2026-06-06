// Standalone demo page for the Tier 1 caster. Hash route: #caster.
//
// Wiring: MockMatch generates fake kill events → we pick a bark template that
// matches the event → renderBark fills in names → AudioQueue speaks it.
// No SpacetimeDB connection — that swap happens in Phase 4.
//
// What this proves before backend integration:
//   - Bark fires <100ms after a kill event (no awaits in the hot path).
//   - Ace preempts a single-kill bark mid-utterance (priority queue works).
//   - Name substitution leaves no visible {killer} placeholders.

import { useEffect, useRef, useState } from "react";
import { pickBark, renderBark } from "./Barks";
import { createMockKillStream, type KillEvent, type Team, type MockMatchController } from "./MockMatch";
import { getSharedAudioQueue } from "./AudioQueue";

interface FeedEntry {
  id: number;
  kind: "kill" | "round_start" | "round_end" | "bark";
  text: string;
  ts: number;
}

// Map a kill event to the right bark category. Picks the highest-priority
// modifier that applies (ace > double > headshot > first_blood > solo).
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

export function CasterDemo() {
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [killCount, setKillCount] = useState(0);

  const controllerRef = useRef<MockMatchController | null>(null);
  const nextIdRef = useRef(1);
  const queue = getSharedAudioQueue();

  const appendFeed = (entry: Omit<FeedEntry, "id" | "ts">) => {
    setFeed((f) => {
      const next = [{ ...entry, id: nextIdRef.current++, ts: Date.now() }, ...f];
      return next.slice(0, 30); // keep the last 30 rows
    });
  };

  // Handle a kill event: log the kill row, then synthesize + speak the bark.
  // Synchronous — no awaits on the hot path so the bark hits the queue inside
  // the same microtask the event fired in (<100ms requirement).
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
    // Dedupe key: same killer+victim+timestamp shouldn't fire twice if the
    // mock stream ever double-emits (it shouldn't, but be defensive).
    const dedupeKey = `${e.killer}|${e.victim}|${Date.now()}`;
    queue.enqueue({ text, priority: template.priority, dedupeKey });
    appendFeed({ kind: "bark", text: `[p${template.priority}] ${text}` });
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
  };

  // Clean up the mock stream if the user navigates away mid-match.
  useEffect(() => {
    return () => {
      controllerRef.current?.stop();
      queue.clear();
    };
  }, [queue]);

  const start = () => {
    // First click counts as the user-gesture that unlocks Web Speech.
    queue.unlock();
    setAudioOn(true);

    if (controllerRef.current) {
      controllerRef.current.stop();
    }
    controllerRef.current = createMockKillStream({
      onKill: handleKill,
      onRoundStart: handleRoundStart,
      onRoundEnd: handleRoundEnd,
    });
    controllerRef.current.start();
    setRunning(true);
  };

  const stop = () => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    queue.clear();
    setRunning(false);
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
          <h1 style={{ margin: 0, fontSize: 26, letterSpacing: 0.5 }}>Valor — AI Caster (Tier 1 demo)</h1>
          <p style={{ opacity: 0.7, marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            Mock kill-stream into priority-queued Web Speech. No SpacetimeDB connection — that wires
            up in Phase 4. Start the mock match and watch the kill feed; the caster speaks each event.
          </p>
        </header>

        <div style={{ display: "flex", gap: 12, marginBottom: 18, alignItems: "center", flexWrap: "wrap" }}>
          {!running ? (
            <button
              onClick={start}
              style={{
                padding: "12px 22px",
                fontSize: 16,
                fontWeight: 600,
                borderRadius: 8,
                border: "none",
                background: "#3a7bff",
                color: "#fff",
                cursor: "pointer",
                boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
              }}
            >
              Start mock match
            </button>
          ) : (
            <button
              onClick={stop}
              style={{
                padding: "12px 22px",
                fontSize: 16,
                fontWeight: 600,
                borderRadius: 8,
                border: "none",
                background: "#ff5050",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          )}
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            audio: {audioOn ? "unlocked" : "locked (click Start)"} · kills: {killCount}
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
            <div style={{ opacity: 0.5 }}>Feed empty. Click "Start mock match" to begin.</div>
          ) : (
            feed.map((entry) => {
              const color =
                entry.kind === "bark"
                  ? "#9be7a3"
                  : entry.kind === "round_start" || entry.kind === "round_end"
                    ? "#ffd166"
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
          Tip: green lines are barks spoken aloud. Yellow lines are round events. White lines are
          kill rows. Watch for an ace bark preempting a solo-kill bark mid-utterance.
        </p>
      </div>
    </div>
  );
}
