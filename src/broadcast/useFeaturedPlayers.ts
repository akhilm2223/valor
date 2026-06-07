// useFeaturedPlayers — director that picks the four players whose POVs are
// shown in the broadcast grid.
//
// Behavior:
//   • Stable assignment: once a slot is filled, it stays on that player as
//     long as they're alive.
//   • When a featured player dies (or is removed), that slot advances to the
//     next alive player by ascending id, picking from those not already in
//     another slot.
//   • If no eligible replacement is available, the slot stays null → the
//     tile renders a placeholder.
//
// Output is an array of length 4 (or N) of player ids (or null for empty
// slots). Callers iterate and render <PovTile playerId={ids[i]} />.

import { useEffect, useState } from "react";
import type { Player } from "../net/Connection";

const SLOT_COUNT = 4;

export function useFeaturedPlayers(
  players: Player[],
  slots: number = SLOT_COUNT,
): (number | null)[] {
  const [featured, setFeatured] = useState<(number | null)[]>(() =>
    new Array(slots).fill(null),
  );

  useEffect(() => {
    setFeatured((prev) => {
      // Index live, alive players by id, ordered ascending.
      const aliveSorted = players
        .filter((p) => p.alive)
        .sort((a, b) => a.id - b.id);
      const aliveIds = aliveSorted.map((p) => p.id);
      const aliveSet = new Set(aliveIds);

      // Pad/truncate prev to match the configured slot count without
      // disturbing valid entries.
      const next: (number | null)[] = new Array(slots).fill(null);
      for (let i = 0; i < slots; i++) {
        const cur = prev[i] ?? null;
        if (cur != null && aliveSet.has(cur)) {
          next[i] = cur;
        }
      }

      // For empty slots, take the lowest-id alive player not already used.
      const used = new Set(next.filter((x): x is number => x != null));
      for (let i = 0; i < slots; i++) {
        if (next[i] != null) continue;
        for (const id of aliveIds) {
          if (used.has(id)) continue;
          next[i] = id;
          used.add(id);
          break;
        }
      }

      // Bail on identical result to avoid pointless re-renders.
      let same = true;
      for (let i = 0; i < slots; i++) {
        if (next[i] !== prev[i]) {
          same = false;
          break;
        }
      }
      return same ? prev : next;
    });
  }, [players, slots]);

  return featured;
}
