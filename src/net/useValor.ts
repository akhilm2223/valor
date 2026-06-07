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

import { useEffect, useRef, useState } from "react";
import { Identity } from "spacetimedb";
import {
  connectValor,
  type ValorConnection,
  type Player,
  type GameMatch,
  type Shot,
  type LeaderboardRow,
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
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      let next: GameMatch | undefined = undefined;
      for (const m of conn.db.game_match.iter()) {
        next = m;
        break;
      }
      setMatch(next);
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
