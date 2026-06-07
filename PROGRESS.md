# Valor / MOSH — Progress

*Last updated: this file is hand-maintained; check `git log` for the truth.*

## TL;DR

**Five phases shipped + QA'd, all on local `main`, nothing pushed.**
**82/82 QA checks pass.** Phase 6 (live demo verification) in progress in the background.

---

## What's built

| # | Phase | Commit | QA | What it ships |
|---|---|---|---|---|
| 1 | Backend gate | `db2ed72` | 8/8 ✅ | SpacetimeDB Rust module: 6 tables (`players`, `game_match`, `shots`, `spectators`, `leaderboard`, `commentary`) + 30Hz scheduled `tick` + reducers (`join`, `submit_input`, `fire`, `tick`, `start_round`, `caster_input`, `on_connect`, `on_disconnect`). Generated TS bindings at `src/stdb/`. Client wrapper at `src/net/Connection.ts`. |
| 2 | Caster Tier 1 | `f265ce3` | 9/9 ✅ | Instant canned barks against mock kill stream. 19 templates (first blood, solo, headshot, double, ace, revenge, round start/win, low ammo, hit warning). Web Speech API for TTS. Priority queue with preemption. `#caster` demo route. |
| 3 | Match loop + leaderboard | `46ec221` | 14/14 ✅ | Full auto state machine: Lobby → Live → RoundEnd → Live (5s cooldown) → MatchEnd at round 5. Per-player `kills` column, team kill counters summed into `leaderboard`. `#leaderboard` UI route. `useSpectatorCam` hook in `src/game/SpectatorCam.tsx` for Akhil to drop in. |
| 4 | LLM caster + spectator | `2be13eb` | 22/22 ✅ | LiveStream replaces mock (real STDB subscription). Color commentary via Claude Haiku 4.5, fully async, 15s abort guard, graceful no-op if `VITE_ANTHROPIC_KEY` missing. Spectator routes: `#spectator` (fixed caster-cam), `#spectator/freefly` (orbit). `#caster/live` runs Tier 1 + Tier 2 together. |
| 5 | Networked multiplayer | `2b14a2b`, `0d6d058`, `a635ebd` | 29/29 ✅ | `src/net/useValor.ts` — six STDB-subscription React hooks. `src/net/Driver.ts` — 30Hz input → reducer translator with diff-gate + rising-edge fire. `src/multiplayer/MultiplayerGame.tsx` at `#multiplayer` — actual networked play view wiring it all together. |
| 6 | Live demo verification | _in progress_ | — | `window.__valor` dev hook on MultiplayerGame + `scripts/smoke-multiplayer.mjs` driving 3 browser contexts to validate the cross-tab gameplay loop. Auto-writes `DEMO-VERIFICATION.md`. |

---

## Routes available (`http://localhost:5175/`)

| Route | What it is |
|---|---|
| `/` | Model studio (animation/gun preview) |
| `/?game` | Akhil's full FPS — weapons, bots, hitscan (single-player) |
| `/#game` | Akhil's arena prototype (single-player) |
| `/#multiplayer` | **The networked play view** — joins STDB, opposite-team auto-balance |
| `/#leaderboard` | Persistent leaderboard subscriber |
| `/#caster` | Tier 1 caster demo (mock kills) |
| `/#caster/live` | Tier 1 + Tier 2 caster against live STDB |
| `/#spectator` | Fixed caster-cam spectator (read-only) |
| `/#spectator/freefly` | Orbit free-fly spectator |

---

## What's running

- **Backend**: local SpacetimeDB instance on `ws://127.0.0.1:3000`, module name `valor`.
- **Frontend**: Vite dev server on `http://localhost:5175/`.
- Both started earlier this session and are still up. Restart with `spacetime start` (background) + `npm run dev` if needed.

---

## What's NOT done (in priority order)

### 1. End-to-end gameplay verification (Phase 6 — currently in progress)
The cross-tab gameplay loop has never actually been exercised. Phase 5 QA validated the code statically and confirmed `#multiplayer` loads without console errors, but no test has yet:
- Joined two tabs and confirmed opposite-team assignment
- Driven WASD and confirmed `players.position` moves on the server
- Fired across tabs and confirmed health drops + kill bark plays + `alive` flips false
- Confirmed the spectator tab makes zero writes

**Phase 6 implementer agent is building the smoke test right now in the background.** It'll write a `DEMO-VERIFICATION.md` with green/red per assertion when done.

### 2. Pushes to `origin/main`
**7 local commits ahead of origin.** Nothing has been pushed since you reverted my push earlier. Your gate — say the word and I'll push.

### 3. `.env.local` for LLM color
`.env.example` documents the keys. Until you `cp .env.example .env.local` and add `VITE_ANTHROPIC_KEY=...`, the Tier 2 LLM color commentary will log a warning and stay silent. Tier 1 barks fire either way.

### 4. Polish (not required for demo)
- **ElevenLabs swap** for caster voice — Web Speech is robotic; the AudioQueue has a `TODO(phase 4)` comment marking the swap point.
- **`is_headshot` field on `Shot`** — currently using a `damage >= 50` proxy in `LiveStream.ts`. For a real headshot you'd add the column + a Y-coordinate check in the `fire` reducer.
- **Bundle code-split** — Vite warned 3.9 MB single chunk. Dynamic-import the spectator + caster routes so studio loads fast.
- **Schema `#[default]` annotations** — the Phase 3 republish required `--delete-data` because new columns lack defaults. Demo-safe; would matter for stateful redeploys.

### 5. Out of scope this session (your call)
- **MediaPipe body input** — the actual differentiator from the original `Valor-plan.md §2`. Was Akhil's lane.
- **Dress rehearsal / submission / demo day** — operational, not codeable.

---

## Demo flow you can run right now

In separate browser tabs:

1. Tab A: `http://localhost:5175/#multiplayer` → name "Aidan" → Join
2. Tab B: `http://localhost:5175/#multiplayer` → name "Akhil" → Join
3. Tab C: `http://localhost:5175/#spectator` → fixed caster-cam, kill feed visible

Verify via SQL:
```
spacetime sql -s local valor "SELECT id, name, team, health, alive FROM players"
```
Expected: two rows on opposite teams (0, 1), both alive at 100 HP.

Fire across tabs, watch `players.health` drop, and `commentary` get a Bark row on kill.

---

## Non-blocking observations carried forward from QA

- LLM API key is exposed client-side via the `anthropic-dangerous-direct-browser-access` header. Acceptable for hackathon scope — rotate the key after the event.
- Double-kill heuristic in `LiveStream.ts` uses a `<5s` window — may double-fire on chained kills.
- Headshot detection is a proxy until `is_headshot` exists server-side.
- `MultiplayerGame` is exported as a named export, not default. `main.tsx` imports it correctly so no runtime impact.

---

## Decisions you can make next

- **Push the 7 commits?** I'll do it the moment you say so.
- **Run the Phase 6 smoke test interactively (`HEADED=1`)** so you can watch Chromium do the cross-tab gameplay? Once the implementer finishes shipping the script, yes.
- **Move on to MediaPipe body input?** Big, but it's the actual hackathon hook from `Valor-plan.md §2`.
- **Stop and just demo what we have?** Already a complete vertical slice (game → server → caster → spectator).
