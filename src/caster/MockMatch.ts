// MockMatch — fakes the kill-feed that Phase 4 will wire to the live SpacetimeDB
// `kill_events` table (or whatever the final schema names it). The caster lane
// is built and tuned against THIS module first so it can't be blocked by the
// backend gate. Phase 4 swap-in: replace `createMockKillStream` with a real
// subscriber to the kill-event table; the KillEvent shape is the contract.

export type Team = "A" | "B";

export interface KillEvent {
  killer: string;
  victim: string;
  team: Team; // killer's team
  isHeadshot: boolean;
  isFirstBlood: boolean;
  isDouble: boolean; // killer's 2nd frag within ~5s
  isAce: boolean; // killer's 5th frag of the round (full enemy team)
}

// Fake roster, 5 per side. Names are short so the speech synth doesn't trip on
// them and the kill feed stays readable on the demo screen.
const ROSTER_A = ["Nova", "Echo", "Blitz", "Sable", "Rook"];
const ROSTER_B = ["Vex", "Cipher", "Halo", "Tag", "Quill"];

export interface MockMatchOpts {
  intervalMs?: { min: number; max: number }; // delay between kill events
  roundDurationMs?: number; // approx. round length before we emit onRoundEnd
  onKill?: (e: KillEvent) => void;
  onRoundStart?: () => void;
  onRoundEnd?: (winner: Team) => void;
}

export interface MockMatchController {
  start(): void;
  stop(): void;
}

const DEFAULTS = {
  intervalMs: { min: 5000, max: 8000 },
  roundDurationMs: 75_000,
};

function pickName(team: Team, exclude?: string): string {
  const pool = (team === "A" ? ROSTER_A : ROSTER_B).filter((n) => n !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}

function otherTeam(t: Team): Team {
  return t === "A" ? "B" : "A";
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Spawns a fake kill stream. Uses setTimeout chains (not setInterval) so we can
// vary the gap between events and avoid drift.
export function createMockKillStream(opts: MockMatchOpts = {}): MockMatchController {
  const interval = opts.intervalMs ?? DEFAULTS.intervalMs;
  const roundDuration = opts.roundDurationMs ?? DEFAULTS.roundDurationMs;

  let running = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let roundTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-round state. Tracks first-blood + each killer's frag count so we can
  // synthesize doubles / aces realistically.
  let firstBloodFired = false;
  const fragCount = new Map<string, number>(); // killer -> frags this round
  const lastFragTime = new Map<string, number>(); // killer -> ms timestamp

  function resetRoundState() {
    firstBloodFired = false;
    fragCount.clear();
    lastFragTime.clear();
  }

  function scheduleNextKill() {
    if (!running) return;
    const delay = randInt(interval.min, interval.max);
    killTimer = setTimeout(emitKill, delay);
  }

  function emitKill() {
    if (!running) return;

    // Pick a random killer + victim from opposite teams.
    const killerTeam: Team = Math.random() < 0.5 ? "A" : "B";
    const victimTeam = otherTeam(killerTeam);
    const killer = pickName(killerTeam);
    const victim = pickName(victimTeam);

    const now = Date.now();
    const prevFrags = fragCount.get(killer) ?? 0;
    const prevTime = lastFragTime.get(killer) ?? 0;

    const isFirstBlood = !firstBloodFired;
    const isHeadshot = Math.random() < 0.3;
    // Double if killer fragged again within 5s of their last kill.
    const isDouble = prevFrags >= 1 && now - prevTime < 5000;
    // Ace = 5th frag of the round (would be a full team wipe in real game).
    const isAce = prevFrags + 1 === 5;

    fragCount.set(killer, prevFrags + 1);
    lastFragTime.set(killer, now);
    if (isFirstBlood) firstBloodFired = true;

    const event: KillEvent = {
      killer,
      victim,
      team: killerTeam,
      isHeadshot,
      isFirstBlood,
      isDouble,
      isAce,
    };
    opts.onKill?.(event);

    scheduleNextKill();
  }

  function scheduleRoundEnd() {
    if (!running) return;
    roundTimer = setTimeout(() => {
      if (!running) return;
      const winner: Team = Math.random() < 0.5 ? "A" : "B";
      opts.onRoundEnd?.(winner);
      // Start a new round shortly after.
      resetRoundState();
      setTimeout(() => {
        if (!running) return;
        opts.onRoundStart?.();
        scheduleRoundEnd();
      }, 3000);
    }, roundDuration);
  }

  return {
    start() {
      if (running) return;
      running = true;
      resetRoundState();
      opts.onRoundStart?.();
      scheduleNextKill();
      scheduleRoundEnd();
    },
    stop() {
      running = false;
      if (killTimer) clearTimeout(killTimer);
      if (roundTimer) clearTimeout(roundTimer);
      killTimer = null;
      roundTimer = null;
    },
  };
}
