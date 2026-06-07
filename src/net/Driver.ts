// Driver — translates per-frame input snapshots into STDB reducer calls at a
// fixed network rate. Plain TS, no React, so the game view can feed it from a
// useFrame loop and never have to think about React render cadence.
//
// Wire-rate vs render-rate
//   The R3F game loop runs at the display refresh (60+ Hz); the server tick
//   advances at ~30 Hz. We submit at the server's cadence (33 ms ≈ 30 Hz) via
//   `setInterval`, with a per-snapshot diff-gate so a player standing still
//   doesn't pump duplicate writes.
//
// Fire path
//   submit_input's `fire_pressed` would only be observed on the next tick,
//   which adds up to 33 ms of avoidable latency. Instead we trigger
//   `conn.reducers.fire(aimVector)` immediately on the rising edge of
//   firePressed, gated by `localPlayer.alive && localPlayer.ammo > 0` so we
//   don't spam dead-player fires. The periodic submit_input passes
//   fire_pressed=false to avoid latching the server's animation state on Fire
//   when the player is just holding the trigger across ticks.
//
// Reload
//   There is no dedicated reload reducer — the server reads `reload` on the
//   submit_input snapshot. Diff-gated alongside aim/lean/crouch.

import type { ValorConnection, Player } from "./Connection";

export interface InputSnapshot {
  aim: { x: number; y: number; z: number };
  lean: { x: number; z: number };
  crouch: boolean;
  firePressed: boolean;
  reload: boolean;
}

export interface DriverOpts {
  /** Submit interval in ms. Defaults to 33 (~30Hz, matches server TICK_DT). */
  tickMs?: number;
}

const EPS = 1e-4;

// Equality check used for the diff-gate. firePressed is deliberately excluded:
// fire is handled on the rising-edge path in updateInput, not by this gate.
function snapEq(a: InputSnapshot, b: InputSnapshot): boolean {
  return (
    Math.abs(a.aim.x - b.aim.x) < EPS &&
    Math.abs(a.aim.y - b.aim.y) < EPS &&
    Math.abs(a.aim.z - b.aim.z) < EPS &&
    Math.abs(a.lean.x - b.lean.x) < EPS &&
    Math.abs(a.lean.z - b.lean.z) < EPS &&
    a.crouch === b.crouch &&
    a.reload === b.reload
  );
}

/**
 * Owns the lifecycle of "current input" → reducer calls. One instance per
 * connected client. The owning React component does:
 *
 *   const driver = useMemo(() => new ValorDriver(conn), [conn]);
 *   useEffect(() => { driver.start(); return () => driver.stop(); }, [driver]);
 *   useFrame(() => driver.updateInput(snapshot, localPlayer));
 */
export class ValorDriver {
  private readonly conn: ValorConnection;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: InputSnapshot | null = null;
  private lastSubmitted: InputSnapshot | null = null;
  private prevFire = false;
  private localPlayer: Player | undefined = undefined;

  constructor(conn: ValorConnection, opts: DriverOpts = {}) {
    this.conn = conn;
    this.tickMs = opts.tickMs ?? 33;
  }

  /**
   * Send a join reducer call. Server-side `join` is idempotent on the caller's
   * identity, so calling more than once (e.g. across StrictMode remounts) is
   * safe.
   */
  join(name: string): void {
    this.conn.reducers.join({ name });
  }

  /**
   * Update the driver's view of the current input + local player snapshot.
   * Called every render frame by the game view's useFrame hook.
   *
   * Fires `fire(aim)` immediately on the rising edge of firePressed (gated on
   * alive + ammo) so weapon latency is render-rate, not tick-rate.
   */
  updateInput(snapshot: InputSnapshot, localPlayer?: Player): void {
    if (localPlayer !== undefined) this.localPlayer = localPlayer;
    this.latest = snapshot;

    if (snapshot.firePressed && !this.prevFire) {
      const lp = this.localPlayer;
      if (lp && lp.alive && lp.ammo > 0) {
        this.conn.reducers.fire({ aimVector: snapshot.aim });
      }
    }
    this.prevFire = snapshot.firePressed;
  }

  /** Begin submitting at `tickMs` cadence. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.flush(), this.tickMs);
  }

  /** Stop the periodic submit. Pending fire() rising-edge calls are still flushed via updateInput. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- internals ----

  private flush(): void {
    if (!this.latest) return;
    const s = this.latest;
    if (this.lastSubmitted && snapEq(s, this.lastSubmitted)) return;
    // fire_pressed=false in the periodic submit so the server's anim-state
    // machine doesn't latch on Fire across ticks while the trigger is held —
    // the rising-edge fire() above already did the visible weapon work.
    this.conn.reducers.submitInput({
      aim: s.aim,
      lean: s.lean,
      crouch: s.crouch,
      firePressed: false,
      reload: s.reload,
    });
    this.lastSubmitted = { ...s, firePressed: false };
  }
}
