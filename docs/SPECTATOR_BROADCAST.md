# Spectator + Broadcast — Implementation Reference

> Recovery doc. If everything in `aidan` is lost, this is the spec to rebuild from. Last verified working: 2026-06-07. Commits: `2611882`, `cddd540`, `ca3e197`.

## What this covers

Three connected features added on top of Phase 5 multiplayer:

1. **Mobile ghost-cam spectator** at `#spectator` (phone touch) and `?mobile=1#spectator` (desktop QA).
2. **QR join system** — one `<QrJoinBadge>` component dropped into four placements: standalone `#join` wall, `#caster/live` corner, `#multiplayer` corner, and `#broadcast` rail.
3. **Broadcast view** at `#broadcast` — 2×2 player POV grid + scrolling commentary + scoreboard, for projecting on a wall during the event.

All three are **read-only** from the game's perspective — they never call `join`, `submit_input`, `fire`, etc. The only write is the spectator → `spectator_join` / `spectator_leave` reducers.

## Architecture in one paragraph

The spectator is invisible to players **by construction**: the `spectators` STDB table carries only `{identity, joined_at}`. Players' clients render from the `players` table only, so spectators have no in-world representation to draw. The broadcast view is just a fancier read-only spectator: it subscribes to the same `players` + `game_match` + `commentary` tables, and renders four follow-cameras + a chyron-style commentary list. The QR badge is a thin React component over `qrcode.react` that auto-derives the spectator URL from `window.location.origin`, so it works the same way on `localhost`, the LAN IP, the Cloudflare quick tunnel, or any future deployed origin without configuration.

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

## 7. All routes summary

| Route | What it is |
|---|---|
| `/` | Lobby — character select + Play |
| `/#multiplayer` | Networked play (Phase 5) — now with QR corner badge |
| `/#caster/live` | Operator panel — start/stop, status, scrolling commentary — now with QR corner badge + "👁 N watching" pill |
| `/#caster` | Tier 1 mock caster demo |
| `/#leaderboard` | Leaderboard view |
| `/#spectator` | Desktop fixed CasterCam (unchanged) **OR** mobile ghost-cam (new, on touch / `?mobile=1`) |
| `/#spectator/freefly` | Desktop drei OrbitControls spectator (unchanged) |
| `/#broadcast` | **NEW** — 2×2 POV grid + commentary rail + QR — wall display |
| `/#join` | **NEW** — full-screen QR wall for projecting "scan to spectate" |
| `/#studio` | Model studio |

---

## 8. Dependencies added

```json
{
  "dependencies": {
    "qrcode.react": "^4.x"
  }
}
```

That's it. No new server-side dependencies.

---

## 9. Verification

Steps to confirm everything works after rebuild:

1. **Build the Rust module**: `cd server && cargo build --release --target wasm32-unknown-unknown`.
2. **Publish**: `spacetime publish -s maincloud -p server --yes=remote valor-xv83g`.
3. **Regenerate bindings**: `spacetime generate --lang typescript --out-dir src/stdb --module-path server`.
4. **Typecheck**: `npx tsc --noEmit` — must be clean.
5. **Dev server**: `npm run dev -- --host` — prints LAN IP.
6. **Cloudflare tunnel** (if Wi-Fi has client isolation): `cloudflared tunnel --url http://localhost:5175` — prints a `*.trycloudflare.com` URL.
7. **Desktop preview**: open `http://localhost:5175/?mobile=1#spectator` — mobile UI renders, mouse drives joystick.
8. **Phone test**: open the tunnel URL `/#join` on laptop, scan QR on phone — phone should land on the mobile ghost-cam spectator and join the world.
9. **Spectators table**: `spacetime sql -s maincloud valor-xv83g "SELECT * FROM spectators"` — should show one row per connected phone, deleted on tab close.
10. **Broadcast**: open the tunnel URL `/#broadcast` — 2×2 grid populates with up to 4 alive players' POVs, top bar shows live score, right rail scrolls commentary, QR badge at the bottom encodes the same tunnel URL.
11. **Caster count**: open `/#caster/live` → click Start live caster → confirm "👁 N watching" pill increments with each connected phone spectator.

---

## 10. Known gotchas

- **QR encoding URL**: `<QrJoinBadge>` derives from `window.location.origin`. If you load the broadcast page on `localhost`, the QR encodes `localhost` and phones can't reach it. Always load the page from a phone-reachable origin (tunnel, LAN IP, or deployed URL) for the QR to work.
- **Drei `<View>` ref**: the DOM tile and the R3F `<View>` must share the same `ref`. The `<View>` must live inside `<Canvas>`; the DOM tile must live outside. Splitting `PovTile` / `PovTileView` keeps this clean.
- **`spectator_join` rejection**: if the server has not been republished with the new reducers, the promise rejects with "no such reducer". The mobile spectator code wraps the call in `.catch(...)` so this is silent. The UI continues to work; only the `spectators` table stays empty.
- **iOS Safari fullscreen**: Apple does not let regular web pages hide the Safari URL bar. The RotateHint shows an "Add to Home Screen" tip when iOS Safari is detected; that's the only way to get true fullscreen on iPhone.
- **iOS Safari orientation lock**: `screen.orientation.lock("landscape")` is rejected on iOS Safari even after fullscreen attempt. The RotateHint covers this case with the rotate-your-phone overlay.
- **StrictMode double-mount**: `useValorConnection` has a guard but can still race in some headless / cold-start environments. In a real browser it settles within ~2s. The smoke harness from earlier (deleted) hit this; manual testing did not.
- **Stale localStorage token**: if the user previously connected to a Maincloud identity that's since been revoked (e.g. after `spacetime logout`), the next connect fails with "Failed to verify token: Unauthorized". Fix: `localStorage.removeItem('valor.stdb.token'); location.reload();` in DevTools.

---

## 11. Recovery order

If `aidan` is gone and you're rebuilding from `main`, do it in this order:

1. **Server first**: add the two reducers + extend `on_disconnect` (`server/src/lib.rs`). Publish + regenerate.
2. **Connection layer**: add `spectators` to `DEFAULT_QUERIES` in `Connection.ts`. Add `useSpectatorCount` to `useValor.ts`.
3. **Shared util**: create `src/spectator/touch.ts`.
4. **Export `SpectatorScene`** from `CasterCam.tsx` (one-word change — `export function`).
5. **Mobile spectator**: build `useMobileGhostCam.ts`, `VirtualJoystick.tsx`, `MobileControls.tsx`, `RotateHint.tsx`, `MobileSpectator.tsx`. Branch in `SpectatorRoute.tsx`.
6. **QR system**: `npm i qrcode.react`. Build `QrJoinBadge.tsx`, `JoinWall.tsx`. Drop badges into `CasterLive.tsx` + `MultiplayerGame.tsx`. Add `#join` to `main.tsx`.
7. **Caster count**: wire `useSpectatorCount` into `CasterLive.tsx` header.
8. **Broadcast view**: build `useFollowCam.ts`, `useFeaturedPlayers.ts`, `CommentaryRail.tsx`, `MatchScoreBar.tsx`, `BroadcastErrorBanner.tsx`, then `PovTile.tsx` (split into two exports), then `BroadcastView.tsx`. Add `#broadcast` to `main.tsx`.
9. **Mobile hygiene**: `index.html` viewport meta + CSS, `vite.config.ts` `allowedHosts`.
10. **Verify** per section 9 above.

Each step is independent enough to land + verify on its own.
