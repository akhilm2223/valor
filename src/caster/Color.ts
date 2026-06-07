// Color — Tier 2 LLM color commentary.
//
// Tier 1 (Barks.ts) handles the instant kill-feed callouts; Tier 2 fills the
// gaps with a 1-2 sentence read of the match state from a real LLM — momentum,
// trash talk by name, round recaps. Priority is LOWER than barks so an ace
// callout always wins over a "Team A clawing back" line.
//
// Hard rules baked into this module:
//   1. The LLM call is FIRE-AND-FORGET. We never await it from a path that's on
//      the game loop or the bark hot-path. If the API key is missing or the
//      request fails, the game keeps running and Tier 1 keeps barking.
//   2. We cap the API at a ~10s interval; spamming would be costly and noisy.
//   3. Big events (round end, ace) can bypass the interval and fire a one-shot
//      line via `notifyBigEvent`.

import type { ValorConnection, Player, GameMatch, Shot } from "../net/Connection";
import { AudioQueue } from "./AudioQueue";

// ---- LLM config ------------------------------------------------------------

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 120;
const LLM_TIMEOUT_MS = 15_000; // request cap so a stalled call doesn't leak

// Priority for color lines. AudioQueue uses 1=chatter, 2=notable, 3=hype —
// barks at p2/p3 always preempt these.
const COLOR_PRIORITY = 1 as const;
// Big-event one-shots (round end, ace) go in at p2 so they're notable but a
// fresh ace bark from Tier 1 can still preempt them.
const BIG_EVENT_PRIORITY = 2 as const;

// Default cadence between color lines (ms). 10s ≈ enough room for 2-3 barks
// between commentary so it doesn't feel like the LLM is hogging the channel.
const DEFAULT_CADENCE_MS = 10_000;

// How many recent shots to summarize in the prompt. Too many = wasted tokens.
const RECENT_SHOTS_WINDOW = 8;

const SYSTEM_PROMPT = `You are an esports color commentator for a fast-paced 5v5 hackathon FPS called Valor. Your job is to add personality between play-by-play calls.

Hard rules:
- Maximum 2 sentences. No bullet points, no preambles, no narrator stage directions.
- Reference players BY NAME from the roster supplied in the user message. Light trash talk is fine; never use slurs or hate speech.
- Read momentum (who's hot, who's slumping, score gap) and react to the round recap when one's supplied.
- Never reference real-world esports teams, brands, streamers, or politicians. No proprietary IP.
- Speak as if you're on a livestream — short, punchy, present tense, casual.
- If the match feels quiet (no recent kills, score 0-0), riff on the tension rather than inventing kills.`;

// ---- Public API -----------------------------------------------------------

export interface ColorOpts {
  /** ms between color lines on the polling lane (default 10s). */
  cadenceMs?: number;
  /**
   * Optional fetch override (test injection). If not provided we use globalThis.fetch.
   * The signature matches the global Fetch API.
   */
  llmFetch?: typeof fetch;
  /**
   * Optional API key override. By default we read VITE_ANTHROPIC_KEY at module
   * load. Pass this for testing (so the test fixture doesn't need to set env).
   */
  apiKey?: string;
  /**
   * If true, the commentator will also POST commentary lines back to the server
   * via the `caster_input` reducer. Defaults to false because the spectator
   * route can stay client-only — the LLM line is only useful as audio.
   */
  publishToServer?: boolean;
}

export interface ColorController {
  start(): void;
  stop(): void;
  /**
   * Trigger an out-of-band color line for a big moment. Bypasses the cadence
   * gate but still fire-and-forget — won't block the caller.
   * Example trigger: round end with the winner, or an ace event.
   */
  notifyBigEvent(prompt: string): void;
}

/**
 * createColorCommentator — pulls match state out of the SDK every ~10s, sends
 * a short snapshot to Anthropic Haiku, and enqueues the response as a p1
 * utterance in `audioQueue`. NEVER blocks the game loop.
 */
export function createColorCommentator(
  conn: ValorConnection,
  audioQueue: AudioQueue,
  opts: ColorOpts = {},
): ColorController {
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  const llmFetch = opts.llmFetch ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  const apiKey =
    opts.apiKey ??
    ((typeof import.meta !== "undefined" &&
      (import.meta as ImportMeta).env &&
      ((import.meta as ImportMeta).env.VITE_ANTHROPIC_KEY as string | undefined)) ||
      undefined);

  if (!apiKey) {
    // Soft warning — the game still runs, only the color lane goes silent.
    console.warn(
      "[caster/Color] VITE_ANTHROPIC_KEY not set; color commentary disabled (barks still active)",
    );
  }
  if (!llmFetch) {
    console.warn("[caster/Color] no fetch implementation available; color disabled");
  }

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Guard against overlapping in-flight requests if the network's slow.
  let inFlight = false;

  // ---- Snapshot builder -------------------------------------------------

  function snapshot(): {
    match: GameMatch | null;
    players: Player[];
    recentShots: Shot[];
  } {
    let match: GameMatch | null = null;
    for (const m of conn.db.game_match.iter()) {
      match = m;
      break;
    }
    const players: Player[] = [];
    for (const p of conn.db.players.iter()) players.push(p);
    // Pull recent shots, sort by fired_at desc, keep top N.
    const allShots: Shot[] = [];
    for (const s of conn.db.shots.iter()) allShots.push(s);
    allShots.sort((a, b) => {
      const ta = a.firedAt.toMillis();
      const tb = b.firedAt.toMillis();
      return ta < tb ? 1 : ta > tb ? -1 : 0;
    });
    return {
      match,
      players,
      recentShots: allShots.slice(0, RECENT_SHOTS_WINDOW),
    };
  }

  function summarizeSnapshot(snap: ReturnType<typeof snapshot>): string {
    const { match, players, recentShots } = snap;
    const lines: string[] = [];

    if (match) {
      lines.push(
        `Round ${match.round} · state ${match.state.tag} · Team A ${match.scoreA} · Team B ${match.scoreB}`,
      );
    } else {
      lines.push("No match in progress yet");
    }

    const aliveA = players.filter((p) => p.team === 0 && p.alive).length;
    const aliveB = players.filter((p) => p.team === 1 && p.alive).length;
    const totalA = players.filter((p) => p.team === 0).length;
    const totalB = players.filter((p) => p.team === 1).length;
    lines.push(`Alive: A ${aliveA}/${totalA} · B ${aliveB}/${totalB}`);

    // Roster — short, used by the LLM so it knows who to call out by name.
    const rosterA = players
      .filter((p) => p.team === 0)
      .map((p) => `${p.name}(K${p.kills}${p.alive ? "" : ",dead"})`);
    const rosterB = players
      .filter((p) => p.team === 1)
      .map((p) => `${p.name}(K${p.kills}${p.alive ? "" : ",dead"})`);
    if (rosterA.length) lines.push(`Team A: ${rosterA.join(", ")}`);
    if (rosterB.length) lines.push(`Team B: ${rosterB.join(", ")}`);

    // Recent kills — name → name, last 8.
    const playersById = new Map<number, Player>();
    for (const p of players) playersById.set(p.id, p);
    const recentKills = recentShots
      .filter((s) => s.victimId !== undefined && s.victimId !== null)
      .slice(0, 5)
      .map((s) => {
        const shooter = playersById.get(s.shooterId)?.name ?? `P${s.shooterId}`;
        const victim = playersById.get(s.victimId as number)?.name ?? `P${s.victimId}`;
        return `${shooter}→${victim}`;
      });
    if (recentKills.length) {
      lines.push(`Recent kills: ${recentKills.join(", ")}`);
    } else {
      lines.push("No kills yet this round");
    }

    return lines.join("\n");
  }

  // ---- LLM call (fire-and-forget) -----------------------------------------

  // Fetch a color line and enqueue it. Returns a Promise but callers MUST NOT
  // await it from a hot path. We attach .catch internally so an unhandled
  // rejection can never crash the renderer.
  async function fetchColorLine(extraContext: string, priority: 1 | 2): Promise<void> {
    if (!apiKey || !llmFetch) return;
    if (inFlight) return; // back-pressure: don't pile up requests
    inFlight = true;

    const userMessage = `${extraContext}\n\nGive me one color-commentary line.`;

    // Timeout via AbortController so a stalled API call doesn't leak.
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);

    try {
      const res = await llmFetch(ANTHROPIC_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          // Required for browser-origin calls to Anthropic's CORS-enabled endpoint.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.warn(`[caster/Color] LLM call failed: HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (json.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join(" ")
        .trim();
      if (!text) return;
      audioQueue.enqueue({ text, priority });
      // Optionally write back into the commentary table so the spectator
      // overlay can show the line as a subtitle even on screens that don't
      // have audio unlocked.
      if (opts.publishToServer) {
        try {
          // The reducer signature: caster_input(kind, text). We pick "Color".
          (conn as unknown as {
            reducers: {
              casterInput: (kind: { tag: "Color" }, text: string) => void;
            };
          }).reducers.casterInput({ tag: "Color" }, text);
        } catch (err) {
          // Auth issues / disconnects shouldn't crash the caster.
          console.warn("[caster/Color] caster_input reducer failed", err);
        }
      }
    } catch (err) {
      // AbortError is expected on timeout; quietly swallow.
      if ((err as Error).name !== "AbortError") {
        console.warn("[caster/Color] LLM error", err);
      }
    } finally {
      clearTimeout(timeoutId);
      inFlight = false;
    }
  }

  // ---- Scheduling -------------------------------------------------------

  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(() => {
      if (!running) return;
      // Build the snapshot synchronously, kick the LLM, schedule next tick.
      const snap = snapshot();
      const context = summarizeSnapshot(snap);
      // FIRE-AND-FORGET — no await. Errors are caught inside fetchColorLine.
      void fetchColorLine(context, COLOR_PRIORITY);
      scheduleNext();
    }, cadenceMs);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      scheduleNext();
    },
    stop(): void {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    notifyBigEvent(prompt: string): void {
      if (!running) return;
      // Snapshot is still useful — gives the LLM the score + roster context.
      const snap = snapshot();
      const context = `${summarizeSnapshot(snap)}\n\nMOMENT: ${prompt}`;
      void fetchColorLine(context, BIG_EVENT_PRIORITY);
    },
  };
}
