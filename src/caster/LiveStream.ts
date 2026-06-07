// LiveStream — Phase 4 replacement for MockMatch.
//
// Subscribes to the LIVE SpacetimeDB tables (shots + game_match + players) and
// fires KillEvents in the SAME shape MockMatch.ts exports, so the rest of the
// caster pipeline (categoryForKill, pickBark, AudioQueue) stays unchanged.
//
// What we watch:
//   • `shots`     — new insert with a non-null victim_id == a confirmed kill.
//                   We translate it into KillEvent (killer name, victim name,
//                   killer team, first-blood / double / ace / headshot flags).
//   • `game_match` — state transitions Lobby→Live trigger onRoundStart, Live→
//                   RoundEnd trigger onRoundEnd(winner). We also reset per-round
//                   state (first-blood, double timing) on each round start.
//   • `players`   — used purely as a lookup table (find by id) so we can render
//                   names + teams without hitting the shots stream's tiny payload.

import type { ValorConnection, Shot, GameMatch, Player } from "../net/Connection";
import type { KillEvent, Team } from "./MockMatch";

// Re-export so callers can `import { KillEvent } from "../caster/LiveStream"`
// if they only want the live path.
export type { KillEvent, Team };

export interface LiveStreamOpts {
  /** Fires once per confirmed kill (shots row with victim_id != null). */
  onKill?: (e: KillEvent) => void;
  /** Lobby→Live (round begins). */
  onRoundStart?: () => void;
  /** Live→RoundEnd. Winner derived from score_a vs score_b at end of round. */
  onRoundEnd?: (winner: Team) => void;
}

export interface LiveStreamController {
  start(): void;
  stop(): void;
}

// Window to detect a "double" — killer scores 2 frags within this period.
// Matches the heuristic in MockMatch so the bark categories pick the same way.
const DOUBLE_WINDOW_MS = 5_000;
// Ace = full-team wipe == killer's 5th frag of the round (5 enemies cleared).
const ACE_FRAG_COUNT = 5;

// shots row's id is u64 -> bigint at runtime. We'd rather de-dup with strings.
function shotKey(s: Shot): string {
  return s.id.toString();
}

function teamFromU8(team: number): Team {
  return team === 0 ? "A" : "B";
}

function looksLikeHeadshot(s: Shot): boolean {
  // The server doesn't (yet) emit a head-flag on Shot, but high-damage rolls
  // are a reasonable proxy for the bark category. 50+ damage = headshot tier.
  // If the schema later grows a real `is_headshot` field, swap this in.
  return s.damage >= 50;
}

/**
 * createLiveKillStream — drop-in replacement for createMockKillStream that pulls
 * its events from a connected SpacetimeDB module.
 *
 * Returns a controller with start/stop. start() registers the SDK callbacks,
 * stop() removes them. Idempotent — calling start twice is a no-op.
 */
export function createLiveKillStream(
  conn: ValorConnection,
  opts: LiveStreamOpts = {},
): LiveStreamController {
  let running = false;

  // Per-round bookkeeping (mirrors MockMatch).
  let firstBloodFired = false;
  const fragCount = new Map<number, number>(); // shooter_id -> frags this round
  const lastFragTime = new Map<number, number>(); // shooter_id -> ms timestamp
  const seenShots = new Set<string>(); // dedupe across re-deliveries

  function resetRoundState(): void {
    firstBloodFired = false;
    fragCount.clear();
    lastFragTime.clear();
    seenShots.clear();
  }

  // Look up a player row by numeric id. The unique-index accessor on the
  // generated client gives us O(n) lookup but the player set is tiny.
  function findPlayer(id: number): Player | null {
    return conn.db.players.id.find(id) ?? null;
  }

  function nameFor(id: number, fallback: string): string {
    return findPlayer(id)?.name ?? fallback;
  }

  // ---- shots → KillEvent ---------------------------------------------------

  const onShotInsert = (_ctx: unknown, shot: Shot): void => {
    if (!running) return;
    // A miss has victim_id == undefined (Rust Option::None over the wire).
    if (shot.victimId === undefined || shot.victimId === null) return;

    // Dedupe — the SDK can replay rows on resubscribe.
    const key = shotKey(shot);
    if (seenShots.has(key)) return;
    seenShots.add(key);
    // Keep the dedupe set bounded.
    if (seenShots.size > 512) {
      const first = seenShots.values().next().value;
      if (first !== undefined) seenShots.delete(first);
    }

    const shooterId = shot.shooterId;
    const victimId = shot.victimId;

    const shooter = findPlayer(shooterId);
    if (!shooter) return; // can't render a name → drop quietly
    const killerName = shooter.name || `P${shooterId}`;
    const victimName = nameFor(victimId, `P${victimId}`);
    const killerTeam = teamFromU8(shooter.team);

    const now = Date.now();
    const prevFrags = fragCount.get(shooterId) ?? 0;
    const prevTime = lastFragTime.get(shooterId) ?? 0;

    const isFirstBlood = !firstBloodFired;
    const isHeadshot = looksLikeHeadshot(shot);
    const isDouble = prevFrags >= 1 && now - prevTime < DOUBLE_WINDOW_MS;
    const isAce = prevFrags + 1 === ACE_FRAG_COUNT;

    fragCount.set(shooterId, prevFrags + 1);
    lastFragTime.set(shooterId, now);
    if (isFirstBlood) firstBloodFired = true;

    const event: KillEvent = {
      killer: killerName,
      victim: victimName,
      team: killerTeam,
      isHeadshot,
      isFirstBlood,
      isDouble,
      isAce,
    };
    opts.onKill?.(event);
  };

  // ---- game_match → round lifecycle ----------------------------------------

  const onMatchUpdate = (_ctx: unknown, oldRow: GameMatch, newRow: GameMatch): void => {
    if (!running) return;
    const prev = oldRow.state.tag;
    const next = newRow.state.tag;
    if (prev === next) return;

    // Lobby→Live OR RoundEnd→Live → a new round just started.
    if (next === "Live" && (prev === "Lobby" || prev === "RoundEnd")) {
      resetRoundState();
      opts.onRoundStart?.();
      return;
    }

    // Live→RoundEnd → round just ended. Pick the winner by current scores.
    if (next === "RoundEnd" && prev === "Live") {
      // If scores tie at the moment of transition, fall back to whichever
      // team is ahead overall (defensive — server logic shouldn't allow ties).
      const winner: Team = newRow.scoreA >= newRow.scoreB ? "A" : "B";
      opts.onRoundEnd?.(winner);
      return;
    }
  };

  // Also handle the case where game_match is INSERTED in the Live state (the
  // first time a client subscribes after the server has already started). We
  // treat that as a round-start so the caster greets the user.
  const onMatchInsert = (_ctx: unknown, row: GameMatch): void => {
    if (!running) return;
    if (row.state.tag === "Live") {
      resetRoundState();
      opts.onRoundStart?.();
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      resetRoundState();
      conn.db.shots.onInsert(onShotInsert);
      conn.db.game_match.onUpdate(onMatchUpdate);
      conn.db.game_match.onInsert(onMatchInsert);
    },
    stop(): void {
      if (!running) return;
      running = false;
      conn.db.shots.removeOnInsert(onShotInsert);
      conn.db.game_match.removeOnUpdate(onMatchUpdate);
      conn.db.game_match.removeOnInsert(onMatchInsert);
    },
  };
}
