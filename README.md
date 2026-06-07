# VALOR — play a real shooter with your body, in your browser

**Live demo:** https://valor-akhil-1v1.surge.sh/#multiplayer
**No download. No controller. Just open a link.**

VALOR is a real-time multiplayer first-person shooter where your **webcam is the controller**. Your hands move you and shoot, and a **wink** zooms in your scope. Your friends can watch the match like a live TV broadcast — with an AI commentator — and vote from their phones by scanning a QR code.

Built for the **SpacetimeDB Launchpad Hackathon** (NY Tech Week, June 2026).

---

## The problem we're solving

Three simple things are broken about playing and watching games today:

1. **Getting in is hard.** Most shooters need a big download, a beefy PC, and a controller or gaming mouse. That's minutes-to-hours of friction before you fire one shot.
2. **Controllers leave people out.** If you can't use a mouse and keyboard well, most FPS games are off-limits.
3. **Watching is boring and one-way.** Spectators just stare at a stream. They can't join in with one tap.

**VALOR fixes all three:** open a link, hold your hands up to your webcam, and you're playing. Anyone can watch and take part from their phone in seconds.

---

## How you play (this all actually works today)

| What you do | What happens |
|---|---|
| Hold **both palms up** to the webcam | Calibrate and start |
| **Left hand — 1 finger** | Walk forward |
| **Left hand — 2 fingers** | Walk back |
| **Left hand — 3 fingers** | Turn right |
| **Left hand — 4 fingers** | Turn left |
| **Left hand — fist** | Stop |
| **Right hand — fist** | Shoot |
| **Wink one eye** | Scope in (zoom) |
| No webcam? | Falls back to **WASD + mouse** |

A light **aim-assist** puts a red ring on an enemy and helps you land the shot, so body-aim is actually playable.

---

## The architecture (the real tech, kept simple)

The key idea: **the whole game runs on the server (SpacetimeDB), and everything else just listens to it.**

```
   YOUR WEBCAM                         SPACETIMEDB (Rust → WebAssembly)
   ┌──────────────┐                    ┌───────────────────────────────────┐
   │ MediaPipe    │   your inputs      │  8 tables · 16 reducers           │
   │ hands + wink │ ─────────────────► │                                   │
   │ One-Euro     │   (send_input,     │  A SCHEDULED REDUCER runs the     │
   │ smoothing    │    fire, join…)    │  game loop 30 times/second:       │
   └──────────────┘                    │   • move players                  │
          ▲                            │   • raycast hit-registration      │
          │ live table updates         │   • round/score state machine     │
          │ (subscriptions)            │   • kill feed + AI commentary     │
   ┌──────┴───────┐                    └──────────────┬────────────────────┘
   │ GAME CLIENT  │                                   │  one source of truth
   │ R3F + three  │ ◄─────────────────────────────────┤  (the live tables)
   │ predicts +   │                                   │
   │ reconciles   │           everyone below is just a SUBSCRIBER:
   └──────────────┘            ┌──────────────┬──────────────┬─────────────┐
                               │ #broadcast   │ #spectator   │ #join       │
                               │ 2×2 cams +   │ mobile       │ QR wall →   │
                               │ AI caster    │ ghost-cam    │ scan + vote │
                               └──────────────┴──────────────┴─────────────┘
```

**Why this is the interesting part:**

- **The server *is* the game, not just a database.** The Rust module runs a `tick` **scheduled reducer** 30 times a second. It moves every player, checks every shot with a raycast, runs the round timer, and writes the kill feed. Players can't cheat because the server decides what really happened.
- **The client feels instant anyway.** Each player predicts their own movement locally every frame, then gently corrects to match the server. So it's both *authoritative* and *smooth*.
- **Every viewer is free.** The broadcast view, the mobile spectator, the AI commentator, and the phone voting all just **subscribe to the same live tables**. We didn't write any extra networking for them — that's SpacetimeDB doing the heavy lifting. One match, many screens, zero extra servers.
- **The AI commentator** writes its lines into a `commentary` table; the broadcast just reads that table live. Instant "always-on" callouts plus longer AI color commentary.

---

## Tech stack

| Layer | What we used |
|---|---|
| **Backend / netcode** | **SpacetimeDB** (Rust module compiled to **WebAssembly**, hosted on Maincloud) |
| **Game client** | **React-Three-Fiber + three.js**, **WebGL**, **TypeScript**, **Zustand** |
| **Body input** | **MediaPipe** (hand + face landmarks) smoothed by a **One-Euro filter** |
| **Live data** | SpacetimeDB **subscriptions** over WebSocket |
| **Build / deploy** | **GitHub Actions** compiles the Rust → wasm; client ships to the web automatically |
| **Testing** | **Vitest** + **Playwright** |

**By the numbers:** 8 SpacetimeDB tables · 16 reducers (including `init`, `client_connected`, `client_disconnected`, and a `tick` scheduled reducer) · 30 Hz server simulation.

---

## Try it (all live right now)

| Link | What it is |
|---|---|
| `…/#multiplayer` | Play. Type a name, pick a side, ready up. Bring a friend for 1v1 or 2v2. |
| `…/#broadcast` | The "esports" view: 2×2 live cams, score bar, AI commentary, start a crowd vote. Great on a big screen. |
| `…/#join` | A big QR code — phones scan it to watch the match. |
| `…/#spectator` | Watch the match (mobile ghost-cam on phones, fixed caster angle on desktop). |

Base URL: **https://valor-akhil-1v1.surge.sh**

---

## The business case (simple version)

**Who would use it**
- **Casual players** who want to jump in instantly — no install, no hardware.
- **Streamers & creators** — body control + a live broadcast view is naturally fun to watch and share.
- **Events, bars, conferences, parties** — put `#broadcast` on the big screen; the whole room joins and votes from their phones.
- **Players left out by controllers** — anyone with a webcam can play.

**How it could make money**
- **Cosmetics** — skins and guns (a golden gun is already modeled).
- **Private rooms & tournaments** — host a match for your group or your event.
- **"Broadcast kit"** — white-label the 2×2 + AI caster + crowd voting for live events and streamers.
- **Sponsored matches / ads** on the broadcast view, and Twitch-style audience engagement (the voting).

**Who we compete with, and why we're better**

| Competitor | What they do | Why VALOR is different |
|---|---|---|
| Browser FPS (Krunker.io, Venge.io, Shell Shockers) | Free, no-install shooters | They still use keyboard/mouse. We add **body control** and a **built-in live broadcast + crowd voting**. |
| Motion games (Wii, Kinect, Just Dance) | Move your body to play | They need special consoles/hardware. We need **only a webcam and a browser tab**. |
| Twitch / streaming | Watch others play | Watching is passive and needs setup. Ours is **interactive** — scan a QR and you're in the match's broadcast in seconds. |

**Our unfair advantage:** lowest possible friction (it's a link), a genuinely novel + shareable control scheme, and a spectator/broadcast layer that's **cheap to scale** because every viewer is just a database subscriber — not a new server.

> Honest status: VALOR is a working hackathon prototype, not a finished business. The core loop, real multiplayer, and the broadcast/voting layer are all live today. The revenue ideas above are the direction, not current income.

---

## Run it locally

```bash
npm install
npm run dev        # client at http://localhost:5174
npm test           # Vitest combat/unit tests
```

The SpacetimeDB Rust module lives in `server/`. It compiles to WebAssembly via GitHub Actions (`.github/workflows/build-server.yml`) and is published to Maincloud. See [`docs/MOSH-STARTER.md`](docs/MOSH-STARTER.md) for the original 3D/asset starter notes.

---

## Team
- **Akhil Mattaparthi**
- **Aidan Yap**

*(plus contributors on the game, characters, and animations)*
