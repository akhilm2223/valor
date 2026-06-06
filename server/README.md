# Valor — SpacetimeDB Module

Authoritative game server for the MOSH body-controlled FPS. See `Valor-plan.md §3` for full schema motivation.

## Prereqs (one-time per machine)

```sh
# Installs SpacetimeDB CLI + a matching Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://install.spacetimedb.com | sh -s -- -y

# Reload PATH (installer puts spacetime in ~/.local/bin)
export PATH="$HOME/.local/bin:$PATH"
spacetime --version
```

## Develop / publish locally

```sh
# Terminal A — boot local STDB instance
spacetime start

# Terminal B — publish the module to the local instance
spacetime publish --project-path server valor

# Generate TypeScript client bindings
spacetime generate \
  --lang typescript \
  --out-dir src/stdb \
  --project-path server
```

## Inspect live state

```sh
spacetime sql valor "SELECT * FROM players"
spacetime sql valor "SELECT * FROM game_match"
spacetime sql valor "SELECT * FROM shots ORDER BY fired_at DESC LIMIT 10"
```

## Module layout

`server/src/lib.rs` defines:

| Table | Purpose |
|---|---|
| `players` | id, identity, name, team, position, aim, lean, crouch, health, ammo, alive, anim_state |
| `game_match` | singleton (id=0): round, scores, timer, state machine |
| `shots` | every `fire()` event + server hit/miss resolution |
| `spectators` | read-only subscribers |
| `leaderboard` | match results (persistent across restarts) |
| `commentary` | caster's bark/color queue |
| `tick_schedule` | drives the 30Hz `tick()` reducer |

Reducers: `init`, `join`, `submit_input`, `fire`, `tick`, `caster_input`, `on_connect`, `on_disconnect`.

**All bodies are stubs.** Phase 1 implementation pass fills in:
- `join` — team auto-balance + spawn placement
- `submit_input` — write per-tick player intent (movement integrates in `tick`)
- `fire` — server raycast vs. player capsules + arena boxes
- `tick` — movement integration, round timer, win condition, respawns
