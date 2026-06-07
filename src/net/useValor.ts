// useValor — React hooks wrapping the SpacetimeDB subscription dance for the
// five tables we care about. Replaces the inline `useEffect` + `iter()` +
// `onInsert/onUpdate/onDelete` bookkeeping that lived in Leaderboard.tsx and
// CasterCam.tsx so future consumers (MultiplayerGame, future overlays) don't
// have to re-author the same plumbing.
//
// Design notes:
//   • Hooks tolerate `conn === null` / not-yet-ready and return empty/undefined
//     so callers can mount them unconditionally and re-render once the
//     connection lands.
//   • `useValorConnection` uses a `useRef` StrictMode guard so React's
//     development double-mount doesn't open two WebSockets (the second one's
//     identity would win and orphan the first).
//   • Cleanup paths always remove the table-cache listeners AND disconnect the
//     underlying connection (only once, even under StrictMode).
//   • `useLocalPlayer` takes `(conn, identity)` explicitly rather than reaching
//     into `(conn as any).identity` so the consumer's types stay clean.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Identity } from "spacetimedb";
import {
  connectValor,
  type ValorConnection,
  type Player,
  type GameMatch,
  type Shot,
  type LeaderboardRow,
  type GoldenVote,
} from "./Connection";

export type ConnStatus = "connecting" | "ready" | "error";

export interface UseValorConnection {
  conn: ValorConnection | null;
  status: ConnStatus;
  identity: Identity | null;
  error: Error | null;
}

/**
 * Opens (or reuses, under StrictMode) the shared SpacetimeDB connection. Fires
 * the standard subscription set from Connection.ts. Identity is stamped once
 * the initial subscription applies.
 */
export function useValorConnection(): UseValorConnection {
  const [conn, setConn] = useState<ValorConnection | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // StrictMode guard. React dev mounts effects twice; without this we'd open a
  // second WebSocket and the second identity would win, orphaning the first.
  const startedRef = useRef(false);
  const connRef = useRef<ValorConnection | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const c = connectValor({
      onReady: (_cc, id) => {
        setIdentity(id);
        setStatus("ready");
      },
      onError: (err) => {
        setStatus("error");
        setError(err instanceof Error ? err : new Error(String(err)));
      },
    });
    connRef.current = c;
    setConn(c);

    return () => {
      try {
        connRef.current?.disconnect();
      } catch {
        /* noop */
      }
      connRef.current = null;
      startedRef.current = false;
    };
  }, []);

  return { conn, status, identity, error };
}

/**
 * Live array of all `players` rows. Mirrors the CasterCam.tsx:125-146 pattern:
 * `iter()` for the initial snapshot, on{Insert,Update,Delete} for diffs, full
 * `removeOn*` cleanup so we don't leak listeners across reconnects.
 */
export function usePlayers(conn: ValorConnection | null): Player[] {
  const [players, setPlayers] = useState<Player[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: Player[] = [];
      for (const p of conn.db.players.iter()) all.push(p);
      setPlayers(all);
    };
    refresh();
    const onAny = () => refresh();
    conn.db.players.onInsert(onAny);
    conn.db.players.onUpdate(onAny);
    conn.db.players.onDelete(onAny);
    return () => {
      conn.db.players.removeOnInsert(onAny);
      conn.db.players.removeOnUpdate(onAny);
      conn.db.players.removeOnDelete(onAny);
    };
  }, [conn]);
  return players;
}

/**
 * Performance-optimized players subscription for the hot render path (the game
 * view). The problem with `usePlayers`: it `setState`s a new array on EVERY row
 * event, and the server rewrites each moving player's row ~30×/s — so the whole
 * React tree re-renders 30–60×/s purely from position churn (it's already
 * consumed in `useFrame`, making the React work pure waste that stutters frames).
 *
 * This hook splits the two concerns:
 *   • `byId` (a ref Map) is updated on EVERY event — read it inside `useFrame`
 *     for live positions/aim. No React involved, so position churn is free.
 *   • `players` (React state) is rebuilt ONLY when a RENDER-relevant field
 *     changes (join/leave/alive/health/ammo/kills/anim/team/name) — NOT on the
 *     per-tick position/lean/aim writes. So rigs mount/unmount + HUD numbers +
 *     animation clips update on real events, and continuous movement triggers
 *     zero re-renders.
 */
export interface PlayersLive {
  players: Player[];
  byId: MutableRefObject<Map<number, Player>>;
}

export function usePlayersLive(conn: ValorConnection | null): PlayersLive {
  const byId = useRef<Map<number, Player>>(new Map());
  const [players, setPlayers] = useState<Player[]>([]);
  const sigRef = useRef("");
  useEffect(() => {
    if (!conn) return;
    const sync = (force: boolean) => {
      const m = byId.current;
      m.clear();
      for (const p of conn.db.players.iter()) m.set(p.id, p);
      const arr = Array.from(m.values()).sort((a, b) => a.id - b.id);
      // Signature of only the fields that affect RENDER output. Position, lean,
      // aim and crouch are deliberately excluded — those flow through `byId`.
      let sig = "";
      for (const p of arr) {
        sig += `${p.id}:${p.alive ? 1 : 0}:${p.health}:${p.ammo}:${p.kills}:${p.deaths}:${p.ready ? 1 : 0}:${p.animState?.tag}:${p.team}:${p.name}|`;
      }
      if (force || sig !== sigRef.current) {
        sigRef.current = sig;
        setPlayers(arr);
      }
    };
    sync(true);
    const onAny = () => sync(false);
    conn.db.players.onInsert(onAny);
    conn.db.players.onUpdate(onAny);
    conn.db.players.onDelete(onAny);
    return () => {
      conn.db.players.removeOnInsert(onAny);
      conn.db.players.removeOnUpdate(onAny);
      conn.db.players.removeOnDelete(onAny);
    };
  }, [conn]);
  return { players, byId };
}

/**
 * The `players` row matching the local identity, or `undefined` while we're
 * still connecting / before the server has acknowledged our join. Takes
 * `identity` explicitly so the consumer's `useValorConnection` result threads
 * through and we don't have to reach into `(conn as any).identity`.
 */
export function useLocalPlayer(
  conn: ValorConnection | null,
  identity: Identity | null,
): Player | undefined {
  const players = usePlayers(conn);
  if (!identity) return undefined;
  return players.find((p) => p.identity.isEqual(identity));
}

/**
 * The singleton `game_match` row (id=0). Updates as the state machine ticks
 * through Lobby/Live/RoundEnd/MatchEnd.
 */
export function useGameMatch(conn: ValorConnection | null): GameMatch | undefined {
  const [match, setMatch] = useState<GameMatch | undefined>(undefined);
  const sigRef = useRef("");
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      let next: GameMatch | undefined = undefined;
      for (const m of conn.db.game_match.iter()) {
        next = m;
        break;
      }
      // The server rewrites round_timer_ms EVERY tick (~30Hz), which would
      // re-render the whole view 30×/s even when nobody moves. Only re-render on
      // a render-relevant change: state/score/round, or the timer's whole SECOND
      // (the HUD only shows seconds). Quantizing the timer kills the storm.
      const sig = next
        ? `${next.state.tag}:${next.scoreA}:${next.scoreB}:${next.round}:${Math.ceil(Number(next.roundTimerMs) / 1000)}`
        : "none";
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setMatch(next);
      }
    };
    refresh();
    const onAny = () => refresh();
    conn.db.game_match.onInsert(onAny);
    conn.db.game_match.onUpdate(onAny);
    conn.db.game_match.onDelete(onAny);
    return () => {
      conn.db.game_match.removeOnInsert(onAny);
      conn.db.game_match.removeOnUpdate(onAny);
      conn.db.game_match.removeOnDelete(onAny);
    };
  }, [conn]);
  return match;
}

/**
 * Newest-first window over the `shots` append-only table. `limit` defaults to
 * 50 so HUD kill feeds (5) and analytics windows (50) both fit.
 */
export function useShots(conn: ValorConnection | null, limit = 50): Shot[] {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: Shot[] = [];
      for (const s of conn.db.shots.iter()) all.push(s);
      all.sort((a, b) => {
        const ta = a.firedAt.toMillis();
        const tb = b.firedAt.toMillis();
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
      setShots(all.slice(0, limit));
    };
    refresh();
    const onInsert = () => refresh();
    conn.db.shots.onInsert(onInsert);
    return () => {
      conn.db.shots.removeOnInsert(onInsert);
    };
  }, [conn, limit]);
  return shots;
}

/**
 * Newest-first window over the `leaderboard` table. `limit` defaults to 10 to
 * match the Leaderboard UI's recent-rounds cap.
 */
export function useLeaderboardRows(
  conn: ValorConnection | null,
  limit = 10,
): LeaderboardRow[] {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: LeaderboardRow[] = [];
      for (const r of conn.db.leaderboard.iter()) all.push(r);
      all.sort((a, b) => {
        const ta = a.playedAt.toMillis();
        const tb = b.playedAt.toMillis();
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
      setRows(all.slice(0, limit));
    };
    refresh();
    const onInsert = () => refresh();
    const onDelete = () => refresh();
    conn.db.leaderboard.onInsert(onInsert);
    conn.db.leaderboard.onDelete(onDelete);
    return () => {
      conn.db.leaderboard.removeOnInsert(onInsert);
      conn.db.leaderboard.removeOnDelete(onDelete);
    };
  }, [conn, limit]);
  return rows;
}

/**
 * Derived view of the Golden Gun vote for the spectator/broadcast overlays.
 * Combines the singleton `game_match` vote fields (state/deadline/winner — they
 * come in via `useGameMatch`, passed in as `match`) with a live tally over the
 * `golden_votes` table. Read-only: the UI casts votes by calling
 * `conn.reducers.castGoldenVote` / `startGoldenVote` directly.
 *
 *   • `state`           — "Idle" | "Voting" | "Reveal" (from GoldenVoteState.tag)
 *   • `endsAtMs`        — wall-clock ms when the current phase ends (server stores
 *                         micros-since-epoch; we divide to ms for Date math)
 *   • `winnerId`        — player id awarded the gun (0 / meaningless unless Reveal)
 *   • `tally`           — playerId → vote count
 *   • `totalVotes`      — number of votes cast this cycle
 *   • `myVoteTargetId`  — the player THIS identity voted for, or null
 */
export interface GoldenVoteView {
  state: "Idle" | "Voting" | "Reveal";
  endsAtMs: number;
  winnerId: number;
  tally: Map<number, number>;
  totalVotes: number;
  myVoteTargetId: number | null;
}

export function useGoldenVote(
  conn: ValorConnection | null,
  identity: Identity | null,
  match: GameMatch | undefined,
): GoldenVoteView {
  const [votes, setVotes] = useState<GoldenVote[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: GoldenVote[] = [];
      for (const v of conn.db.golden_votes.iter()) all.push(v);
      setVotes(all);
    };
    refresh();
    const onAny = () => refresh();
    conn.db.golden_votes.onInsert(onAny);
    conn.db.golden_votes.onUpdate(onAny);
    conn.db.golden_votes.onDelete(onAny);
    return () => {
      conn.db.golden_votes.removeOnInsert(onAny);
      conn.db.golden_votes.removeOnUpdate(onAny);
      conn.db.golden_votes.removeOnDelete(onAny);
    };
  }, [conn]);

  const tally = new Map<number, number>();
  let myVoteTargetId: number | null = null;
  for (const v of votes) {
    tally.set(v.targetPlayerId, (tally.get(v.targetPlayerId) ?? 0) + 1);
    if (identity && v.voterIdentity.isEqual(identity)) {
      myVoteTargetId = v.targetPlayerId;
    }
  }

  const state = (match?.goldenVoteState?.tag ?? "Idle") as GoldenVoteView["state"];
  return {
    state,
    endsAtMs: match ? Number(match.goldenVoteEndsAt) / 1000 : 0,
    winnerId: match?.goldenVoteWinnerId ?? 0,
    tally,
    totalVotes: votes.length,
    myVoteTargetId,
  };
}
