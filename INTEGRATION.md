# Vision controls → Multiplayer integration

**Status:** `main` has both halves merged (zero conflicts):
- **Vision/game** (Akhil): body controls, FPP arms, aim-assist + lock ring, SFX, bots.
- **Net/server** (Aidan): `src/net/` (Connection, Driver, useValor), `src/multiplayer/MultiplayerGame.tsx`, full `server/src/lib.rs` published to **maincloud**, caster + spectator + leaderboard.

**They are NOT wired together yet.** Your gestures drive the *local* single-player game; they need to drive the *networked* player. This doc is the wiring plan.

---

## The seam (the one function to feed)

Aidan's `ValorDriver` (`src/net/Driver.ts`) takes one input shape, every frame:

```ts
interface InputSnapshot {
  aim:   { x: number; y: number; z: number }; // world-space LOOK direction
  lean:  { x: number; z: number };             // x = strafe, z = fwd/back (−1..1)
  crouch: boolean;
  firePressed: boolean;
  reload: boolean;
}
driver.updateInput(snapshot, myPlayerRow);   // call in a useFrame
```

- `updateInput` fires `fire(aim)` **immediately** on the rising edge of `firePressed` (gated on alive + ammo).
- `start()` submits `submit_input(aim, lean, crouch, …)` at ~30 Hz with a diff-gate.
- `join(name)` is idempotent.

Everything you need is already in `useControls` + the camera + `getLock()`. The job is to **translate**, not rebuild.

---

## Task 1 — `<VisionInputBridge>` (small, ~25 lines)

Mount inside the multiplayer scene. Reads your existing systems, pushes snapshots.

```tsx
function VisionInputBridge({ conn, myPlayer, name }) {
  const camera = useThree((s) => s.camera);
  const driver = useMemo(() => new ValorDriver(conn), [conn]);
  useEffect(() => { driver.join(name); driver.start(); return () => driver.stop(); }, [driver, name]);

  useFrame(() => {
    const c = useControls.getState();              // vision → controls (already wired)

    // AIM = assisted look direction. Sending the LOCK-corrected vector means the
    // server's raycast lands on the opponent → aim assist works server-side, free.
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    let aim = { x: fwd.x, y: fwd.y, z: fwd.z };
    const lock = getLock();                          // src/game/aimAssist.ts
    if (lock) {
      const p = camera.position;
      const d = new THREE.Vector3(lock.point[0]-p.x, lock.point[1]-p.y, lock.point[2]-p.z).normalize();
      aim = { x: d.x, y: d.y, z: d.z };
    }

    driver.updateInput({
      aim,
      lean: {
        x: (c.strafeRight ? 1 : 0) - (c.strafeLeft ? 1 : 0),  // 0 in current finger scheme
        z: (c.moveForward ? 1 : 0) - (c.moveBack ? 1 : 0),
      },
      crouch: c.crouch,
      firePressed: c.firePressed,
      reload: c.reloadPressed,
    }, myPlayer);
  });
  return null;
}
```

`conn`, `myPlayer` come from Aidan's `useValor` hooks (`src/net/useValor.ts`).

---

## Task 2 — point the aim-lock at the opponent (small)

`src/game/aimAssist.ts` → `updateLock()` currently scans `useGame.getState().entities` (the **bots**). For multiplayer, iterate the live **`players`** rows from `useValor` instead. Same cone + LOS + hysteresis math; just a different source list (and use each player's `position`). Easiest: pass the target list into `updateLock(origin, aim, targets)`.

---

## Task 3 — server owns position (the real work)

In multiplayer the player's position is **server-authoritative** (the `players` table, moved by `tick()` from your `lean`). So in the MP scene:

- **Turn gesture (yaw)** → rotate the **local camera** → that becomes `aim`. (Local, instant.)
- **Move gesture** → `lean` → **server** moves you → render at the server's position (add client prediction / smoothing if it feels laggy).
- **Opponent** → render from their `players` row. Reuse `AnimatedCharacter` / the bot renderer — a remote player is "a bot driven by the network."
- **Do NOT** also run the local Rapier `PlayerController` as the source of truth — pick one (server) or you get double-movement.

**Start here next session:** read `src/multiplayer/MultiplayerGame.tsx` (620 lines) — it already renders the networked player + camera, so the bridge from Task 1 drops into whatever loop it uses, and Task 3 is mostly "don't fight what it already does."

---

## Server reference (`server/src/lib.rs`, Aidan's, live on maincloud)
- Damage: `SHOT_DAMAGE = 34` (3-shot kill), `MAG_SIZE = 12`, `MAX_RANGE = 60`.
- Rounds: 75 s, best-of-5 (`MATCH_LENGTH_ROUNDS`), auto-restart after a 5 s cooldown.
- Spawns: team A `z=+8`, team B `z=−8` (note: **his arena coords differ from the single-player map** — the MP scene uses his spawns, not `[12,-6,-9.5]`).
- `submit_input(aim, lean, crouch, fire_pressed, reload)`, `fire(aim_vector)`, `join(name)`, 30 Hz `tick()`.

> ⚠️ Coordinate mismatch to resolve: single-player spawns/bots use the `[12,-6,-9.5]` plaza; the server spawns at `z=±8` around origin. The MP scene/camera must use the **server's** coordinate space, or movement/aim will be off.

---

## Quick health check before integrating
```bash
npm install        # Aidan added deps
npm run dev
# open the #multiplayer route → should connect to maincloud + show lobby
```
