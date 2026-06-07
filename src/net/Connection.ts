import { Identity } from "spacetimedb";
import { DbConnection } from "../stdb";
import type { Player, GameMatch, Shot, Commentary, LeaderboardRow } from "../stdb/types";

/**
 * Thin wrapper around the generated SpacetimeDB client. Owns:
 *  - the DbConnection (one per page)
 *  - the cached anon token (so reload reuses identity)
 *  - the standard subscription set (players, game_match, shots, commentary, leaderboard)
 *
 * Consumers do:
 *   const conn = await connectValor({ onReady: c => {...} });
 *   conn.reducers.join("Aidan");
 *   conn.db.players.iter() / onInsert / onUpdate
 *   conn.disconnect();
 */

const STDB_URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? "ws://127.0.0.1:3000";
const STDB_DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? "valor";
const TOKEN_KEY = "valor.stdb.token";

export type ValorConnection = DbConnection;

export interface ConnectOpts {
  /** Fires once the initial subscription has applied — DB views are populated. */
  onReady?: (conn: ValorConnection, identity: Identity) => void;
  /** Fires on connect failure or mid-session drop. */
  onError?: (err: Error) => void;
  /** Optional override for the default subscription set. */
  queries?: string[];
}

const DEFAULT_QUERIES = [
  "SELECT * FROM players",
  "SELECT * FROM game_match",
  "SELECT * FROM shots",
  "SELECT * FROM commentary",
  "SELECT * FROM leaderboard",
  "SELECT * FROM spectators",
];

export function connectValor(opts: ConnectOpts = {}): ValorConnection {
  const cached = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;

  const conn = DbConnection.builder()
    .withUri(STDB_URI)
    .withDatabaseName(STDB_DB)
    .withToken(cached ?? undefined)
    .onConnect((c, identity, token) => {
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* SSR / private mode */ }
      c.subscriptionBuilder()
        .onApplied(() => opts.onReady?.(c, identity))
        .subscribe(opts.queries ?? DEFAULT_QUERIES);
    })
    .onConnectError((_ctx, err) => opts.onError?.(err))
    .onDisconnect((_ctx, err) => { if (err) opts.onError?.(err); })
    .build();

  return conn;
}

/** Clear the cached token so the next connect gets a fresh identity. Use sparingly. */
export function resetValorIdentity(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ }
}

// Re-export the row types so callers can `import { Player } from "../net/Connection"`.
export type { Player, GameMatch, Shot, Commentary, LeaderboardRow };
