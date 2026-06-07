# Spectator + Broadcast — Implementation Reference

> Recovery doc. If everything in `aidan` is lost, this is the spec to rebuild from. Last verified working: 2026-06-07. Commits: `2611882`, `cddd540`, `ca3e197`, plus the in-progress Golden Gun work.

## What this covers

Four connected features added on top of Phase 5 multiplayer:

1. **Mobile ghost-cam spectator** at `#spectator` (phone touch) and `?mobile=1#spectator` (desktop QA).
2. **QR join system** — one `<QrJoinBadge>` component dropped into four placements: standalone `#join` wall, `#caster/live` corner, `#multiplayer` corner, and `#broadcast` rail.
3. **Broadcast view** at `#broadcast` — 2×2 player POV grid + scrolling commentary + scoreboard, for projecting on a wall during the event.
4. **Golden Gun spectator vote** — broadcast operator triggers a 20s vote, phone spectators tap a player chip on their device, the most-voted player gets a one-shot-kill golden gun until they die.

The first three are **read-only** from the game's perspective. Golden Gun voting adds two reducers that *spectators* (not players) can call: `cast_golden_vote` and the operator-only `start_golden_vote`. Players themselves still only ever drive `join` / `submit_input` / `fire`.

## Architecture in one paragraph

The spectator is invisible to players **by construction**: the `spectators` STDB table carries only `{identity, joined_at}`. Players' clients render from the `players` table only, so spectators have no in-world representation to draw. The broadcast view is just a fancier read-only spectator: it subscribes to the same `players` + `game_match` + `commentary` tables, and renders four follow-cameras + a chyron-style commentary list. The QR badge is a thin React component over `qrcode.react` that auto-derives the spectator URL from `window.location.origin`, so it works the same way on `localhost`, the LAN IP, the Cloudflare quick tunnel, or any future deployed origin without configuration. The Golden Gun feature layers a `(state, ends_at, winner_id)` tuple onto `game_match` plus a separate `golden_votes` table keyed by voter identity — the entire vote lifecycle (start → cast → tally → award → consume on death) is driven by the existing 30Hz `tick` reducer plus three new reducers and one modified damage calc inside `fire`.

---

## 1. Server-side (Rust module)

**File: `server/src/lib.rs`**

### Spectator table (pre-existing, do not change)

```rust
#[spacetimedb::table(accessor = spectators, public)]
pub struct Spectator {
    #[primary_key]
    pub identity: Identity,
    pub joined_at: Timestamp,
}
```

Note: no position, no aim, no team. This is the invisibility invariant — players' clients have nothing to render even if they subscribe to this table.

### New reducers

Insert these between the existing `caster_input` reducer and the `on_connect` / `on_disconnect` hooks:

```rust
// =============================================================================
// Spectators — anonymous read-only viewers. Idempotent join, explicit leave.
// Mobile spectator clients (`#spectator` on touch devices) call spectator_join
// on mount and spectator_leave on unmount. The disconnect hook is a safety net
// for tab-close cases where the leave reducer never fires.
// =============================================================================

#[spacetimedb::reducer]
pub fn spectator_join(ctx: &ReducerContext) {
    let me = ctx.sender();
    if ctx.db.spectators().identity().find(me).is_some() {
        return; // idempotent
    }
    ctx.db.spectators().insert(Spectator {
        identity: me,
        joined_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn spectator_leave(ctx: &ReducerContext) {
    ctx.db.spectators().identity().delete(ctx.sender());
}
```

### `on_disconnect` extension

Add the spectator cleanup line to the existing hook so abandoned phones don't leak rows:

```rust
#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender();
    if let Some(p) = ctx.db.players().identity().find(me) {
        ctx.db.players().id().update(Player { alive: false, ..p });
    }
    ctx.db.spectators().identity().delete(me); // ← added
}
```

### Publish to Maincloud

```bash
spacetime publish -s maincloud -p server --yes=remote valor-xv83g
spacetime generate --lang typescript --out-dir src/stdb --module-path server
```

The `generate` step creates `src/stdb/spectator_join_reducer.ts`, `spectator_leave_reducer.ts`, and updates `src/stdb/index.ts` and `src/stdb/types/reducers.ts`. **Never hand-edit any file under `src/stdb/`.**

---

## 2. Client connection layer

**File: `src/net/Connection.ts`**

Default subscription list must include `spectators` so the caster + broadcast can count them:

```ts
const DEFAULT_QUERIES = [
  "SELECT * FROM players",
  "SELECT * FROM game_match",
  "SELECT * FROM shots",
  "SELECT * FROM commentary",
  "SELECT * FROM leaderboard",
  "SELECT * FROM spectators",
];
```

**File: `src/net/useValor.ts`**

Add a hook that returns the live spectator count:

```ts
export function useSpectatorCount(conn: ValorConnection | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      let n = 0;
      for (const _ of conn.db.spectators.iter()) n++;
      setCount(n);
    };
    refresh();
    const onAny = () => refresh();
    conn.db.spectators.onInsert(onAny);
    conn.db.spectators.onDelete(onAny);
    return () => {
      conn.db.spectators.removeOnInsert(onAny);
      conn.db.spectators.removeOnDelete(onAny);
    };
  }, [conn]);
  return count;
}
```

---

## 3. Mobile spectator

### `src/spectator/touch.ts` — shared touch detection

```ts
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "ontouchstart" in window ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
  );
}
```

### `src/spectator/SpectatorRoute.tsx` — branch on touch / `?mobile=1`

```ts
if (hash === "#spectator/freefly") return <FreeFly />;
const forceMobile = new URLSearchParams(window.location.search).has("mobile");
if (isTouchDevice() || forceMobile) return <MobileSpectator />;
return <CasterCam />;
```

Desktop `#spectator` still goes to `CasterCam`. Desktop `#spectator/freefly` still goes to `FreeFly` (drei OrbitControls). Only touch devices and `?mobile=1` get the new mobile UI.

### `src/spectator/CasterCam.tsx` — export `SpectatorScene`

`SpectatorScene` (arena + capsule player markers + lights) needs to be importable. Change the existing `function SpectatorScene(...)` to `export function SpectatorScene(...)`. The mobile spectator and the broadcast view both reuse it.

### `src/spectator/mobile/useMobileGhostCam.ts` — frame-rate-independent ghost camera

Drives the camera each frame from joystick + swipe + button refs. Critical constants:

```ts
const DEADZONE = 0.05;
const SPEED = 6;        // m/s at full joystick deflection
const VSPEED = 6;       // m/s for up/down buttons
const SWIPE_SENS = 0.005; // rad per CSS pixel
const Y_MIN = 2;
const Y_MAX = 35;
const PITCH_INIT = -0.18;
const PITCH_MIN = -1.4;
const PITCH_MAX = 1.4;
const FOLLOW_RATE = 4.0;
const FOLLOW_DIST = 6;
const FOLLOW_HEIGHT = 3;
```

Per-frame logic (clamp `dt` to 0.1 max to survive tab-resume spikes):

```ts
// Drain swipe accumulators into yaw / pitch.
if (yawDeltaPxRef.current !== 0) {
  yawRef.current += yawDeltaPxRef.current * SWIPE_SENS;
  yawDeltaPxRef.current = 0;
}
if (pitchDeltaPxRef.current !== 0) {
  pitchRef.current = clamp(
    pitchRef.current - pitchDeltaPxRef.current * SWIPE_SENS,
    PITCH_MIN, PITCH_MAX
  );
  pitchDeltaPxRef.current = 0;
}

if (followingPlayer) {
  // Orbit around the player at FOLLOW_DIST along current yaw.
  targetPos.set(
    player.x - sin(yaw) * FOLLOW_DIST,
    player.y + FOLLOW_HEIGHT,
    player.z + cos(yaw) * FOLLOW_DIST,
  );
  posRef.lerp(targetPos, 1 - exp(-FOLLOW_RATE * dt));
} else {
  // Joystick = camera-relative translation. Forward = where camera looks.
  if (jmag > DEADZONE) {
    forward.set(sin(yaw), 0, -cos(yaw));
    right.set(cos(yaw), 0, sin(yaw));
    pos.addScaledVector(forward, -jy * SPEED * dt);
    pos.addScaledVector(right,    jx * SPEED * dt);
  }
  pos.y += vyRef * VSPEED * dt;
}
pos.y = clamp(pos.y, Y_MIN, Y_MAX);

camera.position.copy(pos);
camera.quaternion.setFromEuler(new Euler(pitch, yaw, 0, "YXZ"));
```

**Key design decision (locked):** joystick = pure translation, swipe = pure rotation, ▲▼ = pure Y. Don't couple them. The "joystick auto-rotates camera to face direction" model was tried and rejected — it felt floaty.

### `src/spectator/mobile/VirtualJoystick.tsx`

120px circle, 50px knob. Pointer Events API (one component handles touch + mouse + pen). `touchAction: "none"` to suppress browser scroll. `setPointerCapture` to keep tracking even when the finger leaves the joystick area.

Emits `{x, y}` ∈ [-1, 1]² on every move, `{x: 0, y: 0}` on release.

### `src/spectator/mobile/MobileControls.tsx` — overlay layout

- **Bottom-left**: `<VirtualJoystick>`
- **Bottom-right**: stacked ▲ / ▼ buttons (press-hold semantics — `pointerdown` sets `vy = ±1`, `pointerup` clears)
- **Top-center**: `◀ Following X ▶` pill. Center button click clears follow.

Container is `pointerEvents: none` so the canvas underneath gets all gestures except inside the buttons/joystick (which set `pointerEvents: auto`).

### `src/spectator/mobile/RotateHint.tsx` — portrait overlay

Full-screen overlay shown when `matchMedia("(orientation: portrait)")` matches. Spinning 📱 emoji + "Rotate your phone" + (iOS Safari only) Add-to-Home-Screen hint. iOS UA detection:

```ts
const isIos = /iPad|iPhone|iPod/.test(ua);
const isSafari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
const standalone =
  (navigator as any).standalone === true ||
  matchMedia("(display-mode: standalone)").matches;
const showHint = isIos && isSafari && !standalone;
```

### `src/spectator/MobileSpectator.tsx` — top-level

Wires it all together:

1. `useValorConnection()` from `src/net/useValor.ts` — singleton-safe.
2. Refs for inputs (`joystickRef`, `vyRef`, `yawDeltaPxRef`, `pitchDeltaPxRef`, `followTargetIdRef`, `playersRef`). Refs avoid re-renders inside the frame loop.
3. `useEffect` on mount calls `conn.reducers.spectatorJoin({}).catch(...)` (rejected promises must be caught — failure is silent when server doesn't yet have the reducer).
4. `useEffect` cleanup calls `conn.reducers.spectatorLeave({})`.
5. **Follow cycle includes Free fly**: `[null, p0.id, p1.id, ...]` — pressing ◀ from the first player wraps back to `Free fly`.
6. Locks: first user gesture (`pointerdown` listener) tries `requestFullscreen()`, `screen.orientation.lock("landscape")`, `navigator.wakeLock.request("screen")`. iOS Safari rejects all three silently; Android Chrome honors them.
7. Renders R3F `<Canvas>` containing `<SpectatorScene>` + `<GhostCamRig>` (drives the camera) + DOM overlays (`<SwipeCapture>` for yaw/pitch, `<MobileControls>` for joystick/buttons/cycle, `<RotateHint>` last for stacking).

### `index.html` mobile hygiene

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<style>
  html, body, #root {
    margin: 0; height: 100%; background: #0a0a0a; overflow: hidden;
    overscroll-behavior: none;
    -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none;
  }
</style>
```

### `vite.config.ts` — allow tunnel host

```ts
server: {
  host: true,
  port: 5174,
  allowedHosts: [".trycloudflare.com"],
}
```

The leading dot makes Vite treat it as a wildcard. Needed when running through the Cloudflare quick tunnel.

---

## 4. QR join system

### Dependency

```bash
npm install qrcode.react
```

### `src/spectator/QrJoinBadge.tsx`

Two variants: `"badge"` (compact corner, default) and `"wall"` (full-screen). Auto-derives the URL:

```ts
function buildSpectatorUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/#spectator`;
}
```

Renders `<QRCodeSVG value={url} size={size} level="M" />` with a "Scan to spectate" caption. **Important**: the URL derives from whatever origin the page is *loaded on*. If you load the broadcast on `localhost`, the QR encodes `localhost` → phones can't reach it. Load the broadcast on the Cloudflare tunnel URL (or wherever phones can reach) for the QR to actually work.

### `src/spectator/JoinWall.tsx` — `#join` route

Full-page dark radial gradient + centered `<QrJoinBadge variant="wall">`. Meant to be projected.

### Placements

- **`#join`**: `<JoinWall>` is the entire page.
- **`#caster/live`**: corner badge fixed top-right, `size={104}`.
- **`#multiplayer`**: corner badge `position: absolute, bottom: 56, right: 14`, `size={88}`.
- **`#broadcast`**: pinned to the bottom of the right commentary rail, `size={120}`.

### Route wiring (`src/main.tsx`)

```ts
if (hash === "#join") return <JoinWall />;
if (hash === "#broadcast") return <BroadcastView />;
```

---

## 5. Caster spectator count

**File: `src/caster/CasterLive.tsx`**

Mirror the existing `connRef` into a `useState`, then drive `useSpectatorCount`:

```ts
const [conn, setConn] = useState<ValorConnection | null>(null);
const spectatorCount = useSpectatorCount(conn);

// In start(), after connectValor():
const conn = connectValor({
  onReady: () => {
    setConnStatus("ready");
    setConn(conn); // ← added
    /* ... existing code ... */
  },
  /* ... */
});

// In stop():
setConn(null); // ← added so the count resets when the operator stops
```

Render the pill in the header next to the status line:

```tsx
{connStatus === "ready" ? (
  <span style={{
    fontSize: 13, padding: "4px 10px",
    background: "rgba(125,176,255,0.16)",
    border: "1px solid rgba(125,176,255,0.35)",
    borderRadius: 999, color: "#cfe1ff",
    fontWeight: 600, display: "inline-flex",
    alignItems: "center", gap: 6,
  }}>
    <span aria-hidden>👁</span>{spectatorCount} watching
  </span>
) : null}
```

---

## 6. Broadcast view

The audience-facing wall display, **separate from `#caster/live`** (the operator panel).

### Layout

```
┌───────────────────────────────────┐
│           MatchScoreBar           │  64px
├────────────────────┬──────────────┤
│  ┌─POV0─┐ ┌─POV1─┐ │              │
│  └──────┘ └──────┘ │  Commentary  │
│  ┌─POV2─┐ ┌─POV3─┐ │   rail +     │
│  └──────┘ └──────┘ │  QR @ bottom │
└────────────────────┴──────────────┘
```

CSS grid: `gridTemplateColumns: '1fr 340px'`, `gridTemplateRows: '64px 1fr'`, `gridTemplateAreas: '"score score" "grid rail"'`.

### Key technique: drei `<View>` shared canvas

Four player POVs share **one** `<Canvas>`. Each `<PovTile>` is a DOM cell with a ref; inside the canvas, four `<View track={tileRef}>` blocks render their own camera pass into that DOM rect. The arena GLTF is loaded once by `useGLTF` and the GPU geometry buffers are shared across the four views. The cost is ~4× camera passes, not ~4× scene cost.

### Files

**`src/broadcast/useFollowCam.ts`** — third-person trailing camera. Yaw lerps toward `atan2(player.aim.x, -player.aim.z)` via shortest-arc lerp. Position lerps toward `(player.x - sin(yaw)*5, player.y + 2.2, player.z + cos(yaw)*5)`. Reads active camera via `useThree(s => s.camera)` — drei swaps the camera per View pass.

```ts
const FOLLOW_DIST = 5;
const FOLLOW_HEIGHT = 2.2;
const YAW_RATE = 5.0;
const FOLLOW_RATE = 4.0;
const PITCH = -0.18;

function lerpAngle(a: number, b: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  const diff = ((b - a + Math.PI) % TWO_PI) - Math.PI;
  const wrapped = diff < -Math.PI ? diff + TWO_PI : diff;
  return a + wrapped * t;
}
```

**`src/broadcast/useFeaturedPlayers.ts`** — the director. Returns `(number | null)[4]`.

Algorithm:
1. Each render, compute `aliveSorted = players.filter(alive).sort((a,b) => a.id - b.id)`.
2. For each slot: if current id is still alive → keep. Otherwise → take the lowest-id alive player not already in another slot.
3. Bail on identical result to avoid pointless re-renders.

Result: stable assignment, instant swap on death. Between rounds (all dead) all four slots go `null` → placeholders.

**`src/broadcast/PovTile.tsx`** — **split into two components sharing a ref**:

```ts
// DOM cell — renders in the grid area.
export function PovTile({ slotIndex, playerId, players, tileRef }) {
  return (
    <div ref={tileRef}>
      {/* placeholder when playerId == null */}
      {/* bottom-left name+HP+kills badge when alive */}
    </div>
  );
}

// R3F side — renders inside the <Canvas>.
export function PovTileView({ playerId, players, playersRef, tileRef }) {
  return (
    <View track={tileRef}>
      <PerspectiveCamera makeDefault fov={62} near={0.1} far={400} />
      <FollowCamDriver playerId={playerId} playersRef={playersRef} />
      <SpectatorScene players={players} />
    </View>
  );
}
```

Both consume the **same `tileRef`** created in `BroadcastView`. **Critical gotcha**: do not render `<PovTile>` inside the `<Canvas>` — its inner `<View>` block must be a child of `<Canvas>`, but its DOM `<div>` must be a child of the layout grid. Splitting into two components keeps that clean.

**`src/broadcast/CommentaryRail.tsx`** — newest-first scrolling list of `commentary` rows. Subscribes via `useEffect` + `iter()` + `onInsert`. Renders both Bark (canned, orange left-border) and Color (LLM, blue left-border + italic). Capped at 60 rows. **Does not import** `AudioQueue`, `Color`, `LiveStream`, or `Barks` — purely read-only DOM.

**`src/broadcast/MatchScoreBar.tsx`** — top bar. Round/state left, scores center (36px bold), timer right. Lifted from CasterCam's MatchHud with larger type for projection.

**`src/broadcast/BroadcastErrorBanner.tsx`** — bottom-center status pill, hides when `status === "ready"`.

**`src/broadcast/BroadcastView.tsx`** — composes everything:

```tsx
const { conn, status, error } = useValorConnection();
const players = usePlayers(conn);
const match = useGameMatch(conn);
const featuredIds = useFeaturedPlayers(players, 4);

const playersRef = useRef<Player[]>([]);
useEffect(() => { playersRef.current = players; }, [players]);

const tileRefs = useMemo(
  () => Array.from({ length: 4 }, () => ({ current: null } as RefObject<HTMLDivElement | null>)),
  []
);

return (
  <div style={{ /* grid layout */ }}>
    <Canvas style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
            eventSource={document.body} eventPrefix="client">
      {featuredIds.map((id, i) => id == null ? null : (
        <PovTileView key={i} playerId={id} playersRef={playersRef}
                     players={players} tileRef={tileRefs[i]} />
      ))}
    </Canvas>

    <div style={{ gridArea: "score" }}><MatchScoreBar match={match} /></div>

    <div style={{ gridArea: "grid", display: "grid",
                  gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr",
                  gap: 8, padding: 8 }}>
      {featuredIds.map((id, i) => (
        <PovTile key={i} slotIndex={i} playerId={id}
                 players={players} tileRef={tileRefs[i]} />
      ))}
    </div>

    <div style={{ gridArea: "rail", display: "flex", flexDirection: "column" }}>
      <CommentaryRail conn={conn} style={{ flex: 1, overflowY: "auto", minHeight: 0 }} />
      <div style={{ padding: "16px 18px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <QrJoinBadge size={120} caption="Scan to spectate" />
      </div>
    </div>

    <BroadcastErrorBanner status={status} error={error} />
  </div>
);
```

### Route wiring (`src/main.tsx`)

```ts
import { BroadcastView } from "./broadcast/BroadcastView";
// ...
if (hash === "#broadcast") return <BroadcastView />;
```

---

## 7. Golden Gun spectator vote

A spectator-driven special event. The broadcast operator clicks a button, a 20-second vote opens for all phone spectators, the most-voted player wins a one-shot-kill weapon until they die. This sits *inside* the broadcast and mobile-spectator UIs as a **conditional overlay**: when no vote is in flight (the default `Idle` state), the broadcast and mobile spectator render exactly what they do without this feature.

### 7.1 Server-side changes (`server/src/lib.rs`)

**New imports:**

```rust
use std::collections::HashMap;
```

**New constants (top of file with the others):**

```rust
const GOLDEN_VOTE_WINDOW_MS: i64 = 20_000; // 20s voting window
const GOLDEN_REVEAL_MS: i64 = 5_000;       // 5s winner reveal before Idle
```

**New enum (near `MatchState`):**

```rust
#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GoldenVoteState {
    #[default]
    Idle,
    Voting,
    Reveal,
}
```

**`Player` struct — add one field at the end:**

```rust
pub has_golden_gun: bool,
```

**`GameMatch` struct — add three fields:**

```rust
pub golden_vote_state: GoldenVoteState,
/// Wall-clock micros-since-epoch. During Voting = tally deadline.
/// During Reveal = transition-to-Idle deadline.
pub golden_vote_ends_at: i64,
/// Player id of the most recent winner (for Reveal animation). 0 = no winner.
pub golden_vote_winner_id: u32,
```

**New table `golden_votes`** (place after `Spectator`):

```rust
#[spacetimedb::table(accessor = golden_votes, public)]
pub struct GoldenVote {
    #[primary_key]
    pub voter_identity: Identity,
    pub target_player_id: u32,
    pub cast_at: Timestamp,
}
```

PK on `voter_identity` gives "one switchable vote per voter" for free — re-cast is an UPDATE.

**`init` reducer — initialize the new GameMatch fields:**

```rust
ctx.db.game_match().insert(GameMatch {
    /* existing fields */,
    golden_vote_state: GoldenVoteState::Idle,
    golden_vote_ends_at: 0,
    golden_vote_winner_id: 0,
});
```

**`join` reducer — initialize new players:**

```rust
ctx.db.players().insert(Player {
    /* existing fields */,
    has_golden_gun: false,
});
```

**`fire` reducer — one-shot damage when shooter has the gun, clear gun on wielder death:**

```rust
// Replace `let (hit, victim_id, damage) = match best { Some((vid, _)) => (true, Some(vid), SHOT_DAMAGE), ... }` with:
let (hit, victim_id, damage) = match best {
    Some((vid, _)) => {
        let dmg = if shooter.has_golden_gun {
            ctx.db.players().id().find(vid).map(|v| v.health).unwrap_or(SHOT_DAMAGE)
        } else {
            SHOT_DAMAGE
        };
        (true, Some(vid), dmg)
    }
    None => (false, None, 0),
};
```

And inside the victim-update block, add `has_golden_gun: now_alive && victim.has_golden_gun` so the gun clears the moment the wielder dies:

```rust
ctx.db.players().id().update(Player {
    health: new_health,
    alive: now_alive,
    anim_state: if now_alive { AnimState::Hit } else { AnimState::Death },
    has_golden_gun: now_alive && victim.has_golden_gun, // ← added
    ..victim.clone()
});
```

**`tick` reducer — vote state machine, BEFORE the existing round-state block:**

```rust
let now_us = ctx.timestamp.to_micros_since_unix_epoch();
match m.golden_vote_state {
    GoldenVoteState::Voting if now_us >= m.golden_vote_ends_at => {
        finalize_golden_vote(ctx, &m);
    }
    GoldenVoteState::Reveal if now_us >= m.golden_vote_ends_at => {
        ctx.db.game_match().id().update(GameMatch {
            golden_vote_state: GoldenVoteState::Idle,
            golden_vote_ends_at: 0,
            golden_vote_winner_id: 0,
            ..m.clone()
        });
    }
    _ => {}
}
// Re-read after potential state change.
let Some(m) = ctx.db.game_match().id().find(0) else { return };
```

**Two new public reducers + one helper:**

```rust
#[spacetimedb::reducer]
pub fn start_golden_vote(ctx: &ReducerContext) -> Result<(), String> {
    let Some(m) = ctx.db.game_match().id().find(0) else { return Err("no match".into()) };
    if m.state != MatchState::Live {
        return Err("vote only during Live rounds".into());
    }
    if m.golden_vote_state != GoldenVoteState::Idle {
        return Err("vote already in flight".into());
    }
    // Clear any leftover votes from a previous cycle.
    let stale: Vec<Identity> = ctx.db.golden_votes().iter().map(|v| v.voter_identity).collect();
    for id in stale {
        ctx.db.golden_votes().voter_identity().delete(id);
    }
    // Clear any stale gun flag (defensive).
    let armed: Vec<Player> = ctx.db.players().iter().filter(|p| p.has_golden_gun).collect();
    for p in armed {
        ctx.db.players().id().update(Player { has_golden_gun: false, ..p });
    }
    let ends_at = ctx.timestamp.to_micros_since_unix_epoch() + GOLDEN_VOTE_WINDOW_MS * 1000;
    ctx.db.game_match().id().update(GameMatch {
        golden_vote_state: GoldenVoteState::Voting,
        golden_vote_ends_at: ends_at,
        golden_vote_winner_id: 0,
        ..m
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn cast_golden_vote(ctx: &ReducerContext, target_player_id: u32) -> Result<(), String> {
    let Some(m) = ctx.db.game_match().id().find(0) else { return Err("no match".into()) };
    if m.golden_vote_state != GoldenVoteState::Voting {
        return Err("no vote in flight".into());
    }
    let Some(target) = ctx.db.players().id().find(target_player_id) else {
        return Err("no such player".into());
    };
    if !target.alive {
        return Err("target is not alive".into());
    }
    let voter = ctx.sender();
    if let Some(existing) = ctx.db.golden_votes().voter_identity().find(voter) {
        ctx.db.golden_votes().voter_identity().update(GoldenVote {
            target_player_id,
            cast_at: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.golden_votes().insert(GoldenVote {
            voter_identity: voter,
            target_player_id,
            cast_at: ctx.timestamp,
        });
    }
    Ok(())
}

// Helper called by tick when the voting window expires.
fn finalize_golden_vote(ctx: &ReducerContext, m: &GameMatch) {
    let mut tally: HashMap<u32, u32> = HashMap::new();
    for v in ctx.db.golden_votes().iter() {
        *tally.entry(v.target_player_id).or_insert(0) += 1;
    }
    let winner: Option<u32> = tally
        .into_iter()
        .filter(|(pid, _)| ctx.db.players().id().find(*pid).map(|p| p.alive).unwrap_or(false))
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0))) // ties → lowest id
        .map(|(pid, _)| pid);
    if let Some(wid) = winner {
        if let Some(p) = ctx.db.players().id().find(wid) {
            let winner_name = p.name.clone();
            ctx.db.players().id().update(Player { has_golden_gun: true, ..p });
            ctx.db.commentary().insert(Commentary {
                id: 0,
                kind: CommentaryKind::Bark,
                text: format!("{} wins the Golden Gun!", winner_name),
                created_at: ctx.timestamp,
            });
        }
    }
    let reveal_ends_at = ctx.timestamp.to_micros_since_unix_epoch() + GOLDEN_REVEAL_MS * 1000;
    ctx.db.game_match().id().update(GameMatch {
        golden_vote_state: GoldenVoteState::Reveal,
        golden_vote_ends_at: reveal_ends_at,
        golden_vote_winner_id: winner.unwrap_or(0),
        ..m.clone()
    });
}
```

**`on_disconnect` — clear the wielder's gun + drop their vote:**

```rust
#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender();
    if let Some(p) = ctx.db.players().identity().find(me) {
        ctx.db.players().id().update(Player {
            alive: false,
            has_golden_gun: false, // ← added
            ..p
        });
    }
    ctx.db.spectators().identity().delete(me);
    ctx.db.golden_votes().voter_identity().delete(me); // ← added
}
```

### 7.2 Publish + bindings

Adding `has_golden_gun` and the new GameMatch fields to existing tables is a **non-additive schema change** without `#[default]` field annotations. The publish requires `--delete-data` to wipe all current table rows and re-run `init`:

```bash
spacetime publish -s maincloud -p server --yes=remote,delete-data --delete-data valor-xv83g
spacetime generate --lang typescript --out-dir src/stdb --module-path server
```

The `--yes=remote,delete-data` skips the two interactive prompts (non-local-server + destructive-action). After regenerating, three new files appear under `src/stdb/`:

- `golden_votes_table.ts`
- `start_golden_vote_reducer.ts`
- `cast_golden_vote_reducer.ts`

**Gotcha observed during this work**: a publish that doesn't see schema changes may silently fall back to a no-op even if it says `Updated database`. If `spacetime sql -s maincloud valor-xv83g "SELECT * FROM golden_votes"` returns `no such table` after publish, run `cargo clean -p valor --manifest-path server/Cargo.toml --target wasm32-unknown-unknown` and republish.

### 7.3 Client subscription + hook

**`src/net/Connection.ts`** — add `golden_votes` to `DEFAULT_QUERIES`:

```ts
const DEFAULT_QUERIES = [
  /* existing */,
  "SELECT * FROM golden_votes",
];
```

**`src/net/useValor.ts`** — new view-derivation hook:

```ts
export type GoldenVoteStateTag = "Idle" | "Voting" | "Reveal";

export interface GoldenVoteView {
  state: GoldenVoteStateTag;
  endsAtMs: number | null;
  tally: Map<number, number>;
  totalVotes: number;
  myVoteTargetId: number | null;
  winnerId: number;
}

export function useGoldenVote(
  conn: ValorConnection | null,
  identity: Identity | null,
  match: GameMatch | undefined,
): GoldenVoteView {
  const [tally, setTally] = useState<Map<number, number>>(new Map());
  const [myVote, setMyVote] = useState<number | null>(null);
  useEffect(() => {
    if (!conn) return;
    const refresh = () => {
      const t = new Map<number, number>();
      let mine: number | null = null;
      for (const v of conn.db.golden_votes.iter()) {
        t.set(v.targetPlayerId, (t.get(v.targetPlayerId) ?? 0) + 1);
        if (identity && v.voterIdentity.isEqual(identity)) {
          mine = v.targetPlayerId;
        }
      }
      setTally(t);
      setMyVote(mine);
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
  }, [conn, identity]);
  const stateTag = (match?.goldenVoteState?.tag ?? "Idle") as GoldenVoteStateTag;
  const endsAtMs =
    stateTag === "Idle" || !match
      ? null
      : Math.floor(Number(match.goldenVoteEndsAt) / 1000); // i64 micros → number ms
  const totalVotes = Array.from(tally.values()).reduce((s, n) => s + n, 0);
  return { state: stateTag, endsAtMs, tally, totalVotes, myVoteTargetId: myVote, winnerId: match?.goldenVoteWinnerId ?? 0 };
}
```

### 7.4 Broadcast overlay

**`src/broadcast/useGoldenVoteCountdown.ts`** — 4Hz local ticker derived from `endsAtMs`:

```ts
export function useGoldenVoteCountdown(endsAtMs: number | null): number {
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (endsAtMs == null) { setSecondsLeft(0); return; }
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000)));
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [endsAtMs]);
  return secondsLeft;
}
```

**`src/broadcast/GoldenVotePanel.tsx`** — conditional overlay card:

- Returns `null` when `view.state === "Idle"`.
- During `Voting`: gold-bordered pulsing card with 🟡 GOLDEN GUN VOTE title, big countdown (32px), one bar per alive player (team color dot, name, animated gold gradient bar showing `tally[id] / totalVotes`, vote count), and "N votes cast" total.
- During `Reveal`: replaces card with "🏆 WINNER: <name>" (40px bold) over gold-tinted backdrop. Auto-dismisses when tick flips back to Idle.

Mount inside `BroadcastView` as absolute-positioned overlay across the top of the grid area:

```tsx
{goldenVote.state !== "Idle" ? (
  <div style={{
    position: "absolute", top: 76, left: 16, right: 356,
    zIndex: 3, pointerEvents: "none",
  }}>
    <GoldenVotePanel view={goldenVote} players={players} />
  </div>
) : null}
```

**`src/broadcast/MatchScoreBar.tsx`** — accept optional `right?: ReactNode` slot:

```ts
interface MatchScoreBarProps {
  match: GameMatch | undefined;
  style?: React.CSSProperties;
  right?: React.ReactNode;
}
```

Renders the slot to the right of the timer cell with `gap: 14`.

**`src/broadcast/BroadcastView.tsx`** — wire the operator button into the right slot:

```tsx
const onStartVote = useCallback(() => {
  if (!conn) return;
  conn.reducers.startGoldenVote({}).catch((e) => {
    console.warn("[broadcast] start_golden_vote rejected:", e);
  });
}, [conn]);

// Button is shown whenever no vote is in flight; server enforces Live state.
const operatorSlot =
  goldenVote.state === "Voting" ? (
    <span style={statusPillStyle}>VOTING · {secondsLeftForButton}s</span>
  ) : goldenVote.state === "Reveal" ? (
    <span style={statusPillStyle}>WINNER REVEAL</span>
  ) : (
    <button onClick={onStartVote} style={goldButtonStyle}>🟡 Start Golden Vote</button>
  );

<MatchScoreBar match={match} right={operatorSlot} />
```

### 7.5 Mobile spectator vote bar

**`src/spectator/mobile/GoldenVoteBar.tsx`** — top-of-screen banner shown only when vote is active:

- Returns `null` when `view.state === "Idle"`.
- During `Voting`: position `absolute top:0`, gold-tinted background, header with countdown, horizontal scrolling row of alive-player chips. Each chip = team color dot + name + vote-count badge. Tapping a chip calls `conn.reducers.castGoldenVote({ targetPlayerId: id })`. The chip the user has currently voted for is highlighted with a 2px gold ring.
- During `Reveal`: replaces banner with "🏆 <name> wins the Golden Gun!" centered for 5s.

Mount inside `MobileSpectator` as the last layer above the canvas and controls but below `RotateHint`:

```tsx
<GoldenVoteBar view={goldenVote} players={players} conn={conn} />
```

### 7.6 Gun variant swap

The visual `GunVariant = "golden"` already exists in `src/Gun.tsx` (defined since before this work, just never used). Three swap points:

**`src/multiplayer/MultiplayerGame.tsx`** — `LocalPlayerRig` + `RemotePlayerRig`:

```tsx
const gunVariant = player.hasGoldenGun ? "golden" : "normal";
<FitModel
  /* ... */
  hold={<Gun length={0.22} variant={gunVariant} />}
/>
```

**`src/game/FpvArms.tsx`** — accept a `variant?: GunVariant` prop and thread to the held gun:

```tsx
interface FpvArmsProps {
  variant?: GunVariant;
}
export function FpvArms({ variant = "normal" }: FpvArmsProps = {}) {
  // ... existing logic ...
  <AnimatedCharacter
    url="/models/character_a.glb"
    animState={anim}
    hold={<Gun length={0.22} variant={variant} />}
  />
}
```

**`src/multiplayer/MultiplayerGame.tsx`** — pass the variant into the FPV arms when the local player holds the gold:

```tsx
{joined && localPlayer?.alive ? (
  <AssetBoundary>
    <FpvArms variant={localPlayer.hasGoldenGun ? "golden" : "normal"} />
  </AssetBoundary>
) : null}
```

So the wielder sees gold in first person + everyone else sees gold in third person, all driven by the same networked `players.has_golden_gun` field.

### 7.7 Files added/modified

**New:**
- `src/broadcast/GoldenVotePanel.tsx`
- `src/broadcast/useGoldenVoteCountdown.ts`
- `src/spectator/mobile/GoldenVoteBar.tsx`
- `src/stdb/golden_votes_table.ts` (regenerated)
- `src/stdb/cast_golden_vote_reducer.ts` (regenerated)
- `src/stdb/start_golden_vote_reducer.ts` (regenerated)

**Modified:**
- `server/src/lib.rs` — schema, two reducers, helper, tick branch, fire change, on_disconnect cleanup, init + join field initialization.
- `src/net/Connection.ts` — `golden_votes` added to default subscriptions.
- `src/net/useValor.ts` — `useGoldenVote` hook.
- `src/broadcast/BroadcastView.tsx` — mount `<GoldenVotePanel>` + operator slot.
- `src/broadcast/MatchScoreBar.tsx` — optional `right` slot.
- `src/spectator/MobileSpectator.tsx` — mount `<GoldenVoteBar>`.
- `src/multiplayer/MultiplayerGame.tsx` — gun variant swap (Local + Remote rigs + FpvArms call).
- `src/game/FpvArms.tsx` — `variant?: GunVariant` prop.

**Not touched:**
- `src/caster/CasterLive.tsx` — operator runs the vote from `#broadcast` directly.
- `src/Gun.tsx` — the gold variant material palette already existed.

### 7.8 Operator flow during a demo

1. Players join `#multiplayer` (need at least 2 on opposite teams; tick auto-starts the round).
2. Operator opens `#broadcast` on a laptop or projector.
3. Phone spectators scan the QR on the broadcast's right rail → land on `#spectator` (mobile ghost-cam).
4. Operator clicks **🟡 Start Golden Vote** in the top-right of the score bar.
5. Mobile spectators see a banner appear, tap their chosen player. They can re-tap to switch within the 20s window.
6. At 0s: broadcast shows "🏆 WINNER: <name>" for 5s. Winner's `players.has_golden_gun` flips true.
7. Multiplayer clients re-render the winner's Gun as gold (first-person + third-person). Any shot they fire = instant kill.
8. Winner dies → `has_golden_gun` flips false in the same `fire` reducer update → gun reverts to normal.

### 7.9 Edge cases handled

- **No votes cast**: tally empty → winner is `None` → broadcast shows "🤷 No winner", mobile banner same, no `has_golden_gun` is set.
- **Winner dies during the 5s Reveal**: gun was never awarded (because the gun-flip happens inside the same tally block — if the winner died between the start of Voting and finalize, they're filtered out by the `p.alive` predicate in `max_by`).
- **Operator clicks Start while a vote is in flight**: server returns `Err("vote already in flight")`; button is replaced with a status pill so the operator can't double-click anyway.
- **Operator clicks Start during Lobby/RoundEnd**: server returns `Err("vote only during Live rounds")`. UI button stays visible (intentional, as an affordance) but rejection is logged to console.
- **Spectator votes for a dead player**: server returns `Err("target is not alive")`. The mobile bar filters its chip list to alive players only, so this should only happen if a player dies mid-tap.
- **Spectator's tab closes during voting**: `on_disconnect` deletes their `golden_votes` row, so the tally adjusts downward.

---

## 8. All routes summary

| Route | What it is |
|---|---|
| `/` | Lobby — character select + Play |
| `/#multiplayer` | Networked play (Phase 5) — now with QR corner badge. Gun renders gold + one-shots when `players.has_golden_gun` is true. |
| `/#caster/live` | Operator panel — start/stop, status, scrolling commentary — now with QR corner badge + "👁 N watching" pill |
| `/#caster` | Tier 1 mock caster demo |
| `/#leaderboard` | Leaderboard view |
| `/#spectator` | Desktop fixed CasterCam (unchanged) **OR** mobile ghost-cam with Golden Vote bar (new, on touch / `?mobile=1`) |
| `/#spectator/freefly` | Desktop drei OrbitControls spectator (unchanged) |
| `/#broadcast` | **NEW** — 2×2 POV grid + commentary rail + QR — wall display. Top-right of score bar: 🟡 Start Golden Vote button. Gold vote overlay across top of grid when vote is active. |
| `/#join` | **NEW** — full-screen QR wall for projecting "scan to spectate" |
| `/#studio` | Model studio |

---

## 9. Dependencies added

```json
{
  "dependencies": {
    "qrcode.react": "^4.x"
  }
}
```

That's it. No new server-side dependencies.

---

## 10. Verification

Steps to confirm everything works after rebuild:

1. **Build the Rust module**: `cd server && cargo build --release --target wasm32-unknown-unknown`.
2. **Publish**: `spacetime publish -s maincloud -p server --yes=remote,delete-data --delete-data valor-xv83g` (the `--delete-data` flag is required when the Golden Gun schema additions land for the first time; once the live schema matches, future publishes can drop it).
3. **Regenerate bindings**: `spacetime generate --lang typescript --out-dir src/stdb --module-path server`.
4. **Typecheck**: `npx tsc --noEmit` — must be clean.
5. **Dev server**: `npm run dev -- --host` — prints LAN IP.
6. **Cloudflare tunnel** (if Wi-Fi has client isolation): `cloudflared tunnel --url http://localhost:5175` — prints a `*.trycloudflare.com` URL.
7. **Desktop preview**: open `http://localhost:5175/?mobile=1#spectator` — mobile UI renders, mouse drives joystick.
8. **Phone test**: open the tunnel URL `/#join` on laptop, scan QR on phone — phone should land on the mobile ghost-cam spectator and join the world.
9. **Spectators table**: `spacetime sql -s maincloud valor-xv83g "SELECT * FROM spectators"` — should show one row per connected phone, deleted on tab close.
10. **Broadcast**: open the tunnel URL `/#broadcast` — 2×2 grid populates with up to 4 alive players' POVs, top bar shows live score, right rail scrolls commentary, QR badge at the bottom encodes the same tunnel URL.
11. **Caster count**: open `/#caster/live` → click Start live caster → confirm "👁 N watching" pill increments with each connected phone spectator.
12. **Golden Gun**: with at least 2 alive players on opposite teams (match auto-enters Live), open `/#broadcast` and click **🟡 Start Golden Vote** in the top-right of the score bar. Phone spectators see a gold banner appear and tap a player chip. After 20s, the winner is announced and their next shot one-shots an enemy.
    - SQL probe: `spacetime sql -s maincloud valor-xv83g "SELECT * FROM golden_votes"` shows each spectator's vote; `SELECT has_golden_gun FROM players` flips to `true` for the winner.

---

## 11. Known gotchas

- **QR encoding URL**: `<QrJoinBadge>` derives from `window.location.origin`. If you load the broadcast page on `localhost`, the QR encodes `localhost` and phones can't reach it. Always load the page from a phone-reachable origin (tunnel, LAN IP, or deployed URL) for the QR to work.
- **Drei `<View>` ref**: the DOM tile and the R3F `<View>` must share the same `ref`. The `<View>` must live inside `<Canvas>`; the DOM tile must live outside. Splitting `PovTile` / `PovTileView` keeps this clean.
- **`spectator_join` / `cast_golden_vote` rejection**: if the server has not been republished with the new reducers, the promise rejects with "no such reducer". Both the mobile spectator and the broadcast wrap calls in `.catch(...)` so this is silent. The UI continues to work; only the corresponding table (`spectators` / `golden_votes`) stays empty.
- **iOS Safari fullscreen**: Apple does not let regular web pages hide the Safari URL bar. The RotateHint shows an "Add to Home Screen" tip when iOS Safari is detected; that's the only way to get true fullscreen on iPhone.
- **iOS Safari orientation lock**: `screen.orientation.lock("landscape")` is rejected on iOS Safari even after fullscreen attempt. The RotateHint covers this case with the rotate-your-phone overlay.
- **StrictMode double-mount**: `useValorConnection` has a guard but can still race in some headless / cold-start environments. In a real browser it settles within ~2s. The smoke harness from earlier (deleted) hit this; manual testing did not.
- **Stale localStorage token**: if the user previously connected to a Maincloud identity that's since been revoked (e.g. after `spacetime logout` OR after a `--delete-data` republish), the next connect fails with "Failed to verify token: Unauthorized" or surfaces as a generic "[object Event]" error on the broadcast. Fix: `localStorage.removeItem('valor.stdb.token'); location.reload();` in DevTools. Do this on **every** open tab after a Maincloud wipe.
- **Publish silently no-ops**: occasionally `spacetime publish` says `Updated database` but the new schema isn't actually live (observed during Golden Gun development). Probe with `spacetime sql -s maincloud valor-xv83g "SELECT * FROM <new_table>"` — if it errors with `no such table`, run `cargo clean -p valor --manifest-path server/Cargo.toml --target wasm32-unknown-unknown` and republish.
- **Golden Gun requires Live state**: `start_golden_vote` rejects with `"vote only during Live rounds"` when the match is in Lobby or RoundEnd. Need at least 2 alive players on opposite teams so `tick` auto-starts a round.

---

## 12. Recovery order

If `aidan` is gone and you're rebuilding from `main`, do it in this order:

1. **Server first (spectators)**: add the two reducers + extend `on_disconnect` (`server/src/lib.rs`). Publish + regenerate.
2. **Connection layer**: add `spectators` to `DEFAULT_QUERIES` in `Connection.ts`. Add `useSpectatorCount` to `useValor.ts`.
3. **Shared util**: create `src/spectator/touch.ts`.
4. **Export `SpectatorScene`** from `CasterCam.tsx` (one-word change — `export function`).
5. **Mobile spectator**: build `useMobileGhostCam.ts`, `VirtualJoystick.tsx`, `MobileControls.tsx`, `RotateHint.tsx`, `MobileSpectator.tsx`. Branch in `SpectatorRoute.tsx`.
6. **QR system**: `npm i qrcode.react`. Build `QrJoinBadge.tsx`, `JoinWall.tsx`. Drop badges into `CasterLive.tsx` + `MultiplayerGame.tsx`. Add `#join` to `main.tsx`.
7. **Caster count**: wire `useSpectatorCount` into `CasterLive.tsx` header.
8. **Broadcast view**: build `useFollowCam.ts`, `useFeaturedPlayers.ts`, `CommentaryRail.tsx`, `MatchScoreBar.tsx`, `BroadcastErrorBanner.tsx`, then `PovTile.tsx` (split into two exports), then `BroadcastView.tsx`. Add `#broadcast` to `main.tsx`.
9. **Mobile hygiene**: `index.html` viewport meta + CSS, `vite.config.ts` `allowedHosts`.
10. **Golden Gun (server)**: add `has_golden_gun` to Player, `golden_vote_state` / `golden_vote_ends_at` / `golden_vote_winner_id` to GameMatch, `GoldenVoteState` enum, `golden_votes` table. Add `start_golden_vote` + `cast_golden_vote` + `finalize_golden_vote` helper. Extend `tick` + `fire` + `on_disconnect` + `init` + `join`. Publish with `--delete-data` + regenerate.
11. **Golden Gun (client)**: add `golden_votes` to `DEFAULT_QUERIES`. Add `useGoldenVote` to `useValor.ts`. Build `useGoldenVoteCountdown.ts`, `GoldenVotePanel.tsx`, `GoldenVoteBar.tsx`. Add `right` slot to `MatchScoreBar.tsx`. Wire the panel + button into `BroadcastView.tsx`. Wire the bar into `MobileSpectator.tsx`. Swap Gun variant in `MultiplayerGame.tsx` (Local + Remote rigs + FpvArms). Add `variant?: GunVariant` prop to `FpvArms.tsx`.
12. **Verify** per section 10 above.

Each step is independent enough to land + verify on its own. Steps 1–9 produce a working spectator + broadcast without the Golden Gun. Steps 10–11 layer the vote feature on top.
