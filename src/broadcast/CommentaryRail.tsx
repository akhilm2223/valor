// CommentaryRail — read-only scrolling commentary feed for the broadcast view.
//
// Subscribes directly to the STDB `commentary` table via the passed-in
// connection. Renders both Bark (canned) and Color (LLM) rows newest-first.
// Pure presentational — no audio, no operator buttons, no start/stop. The
// caster operator (#caster/live) is responsible for inserting rows; this
// component just observes the table.
//
// Pattern mirrors useLatestColor in src/spectator/CasterCam.tsx:201-225 but
// keeps all rows (not just the latest) and reacts to inserts only — the
// commentary table is append-only on the server side.

import { useEffect, useState } from "react";
import type {
  ValorConnection,
  Commentary,
} from "../net/Connection";
import { stripTags } from "../net/playerModel";

interface CommentaryRailProps {
  conn: ValorConnection | null;
  style?: React.CSSProperties;
  /** Cap the rendered rows so the list never grows without bound. */
  limit?: number;
}

export function CommentaryRail({ conn, style, limit = 60 }: CommentaryRailProps) {
  const rows = useCommentaryFeed(conn, limit);
  return (
    <div
      style={{
        background: "#11151b",
        color: "#fff",
        font: "16px/1.5 system-ui, sans-serif",
        padding: "16px 18px",
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          opacity: 0.55,
          marginBottom: 12,
          fontWeight: 700,
        }}
      >
        Live Commentary
      </div>
      {rows.length === 0 ? (
        <div style={{ opacity: 0.45, fontSize: 14 }}>
          Waiting for the caster to start…
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((row) => (
            <CommentaryItem key={String(row.id)} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentaryItem({ row }: { row: Commentary }) {
  const isColor = row.kind.tag === "Color";
  return (
    <div
      style={{
        padding: "10px 12px",
        background: isColor ? "rgba(125,176,255,0.08)" : "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderLeft: `3px solid ${isColor ? "#7db0ff" : "#ff8a6e"}`,
        borderRadius: 6,
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          opacity: 0.55,
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        {isColor ? "Color" : "Play-by-play"}
      </div>
      <div style={{ fontStyle: isColor ? "italic" : "normal" }}>
        {stripTags(row.text)}
      </div>
    </div>
  );
}

// useCommentaryFeed — newest-first window over the commentary table.
// Subscribes once per `conn` and refreshes on every insert.
function useCommentaryFeed(conn: ValorConnection | null, limit: number): Commentary[] {
  const [rows, setRows] = useState<Commentary[]>([]);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const all: Commentary[] = [];
      for (const c of conn.db.commentary.iter()) all.push(c);
      all.sort((a, b) => {
        const ta = a.createdAt.toMillis();
        const tb = b.createdAt.toMillis();
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
      setRows(all.slice(0, limit));
    };
    refresh();
    const onInsert = () => refresh();
    conn.db.commentary.onInsert(onInsert);
    return () => {
      conn.db.commentary.removeOnInsert(onInsert);
    };
  }, [conn, limit]);
  return rows;
}
