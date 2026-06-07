// useGoldenVoteCountdown — derives seconds-left from a wall-clock end
// timestamp. Updates ~4Hz so the visible countdown feels responsive without
// over-rendering the rest of the broadcast.

import { useEffect, useState } from "react";

export function useGoldenVoteCountdown(endsAtMs: number | null): number {
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (endsAtMs == null) {
      setSecondsLeft(0);
      return;
    }
    const update = () => {
      const left = Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
      setSecondsLeft(left);
    };
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [endsAtMs]);
  return secondsLeft;
}
