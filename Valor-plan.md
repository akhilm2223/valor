# MOSH — Body-Controlled Team FPS (Final Build Plan)

*SpacetimeDB Launchpad Hackathon · NY Tech Week · The Yard, Herald Square · Jun 5–7, 2026 · Team of 4*

---

## The one-line version

A browser **team-based first-person shooter** where your **body is the controller**. Open a link on your laptop, calibrate for 3 seconds, and your webcam turns you into the gun: hand aims a Valorant/CS-style fixed crosshair, squeeze your off-hand to fire, lean to move, dip to crouch. Matches scale from 1v1 to **5v5**. The whole match runs *inside* SpacetimeDB as the authoritative game server, streams to a big screen and to **every phone in the room** (free-fly spectator mode), and an **AI caster** calls the fight over the speakers.

*Valorant, controlled by your body, refereed by a database, narrated by an AI — with the whole room flying through the match.*

---

## 1. The game

Team-based roaming FPS: free 360° look, walk/strafe movement, crouch, one weapon (semi-auto pistol), team-elimination rounds in a small arena with two spawn sides. Find opponents, place deliberate shots, manage a 12-round mag, don't get caught reloading.

**Teams are in the schema from hour one** (`team` field, team spawns, round = team elimination, friendly fire off) — at the reducer level NvN is nearly free. Players join by **shared link on their own laptops**. Develop and test as 1v1/2v2; **the judged demo is a 5v5** (see demo plan). Keep rounds 60–90s — fatigue AND legibility.

- **One gun, on purpose: semi-auto pistol.** One squeeze = one bullet = one server raycast. No spray patterns, no held-trigger detection, no spread math. Limited mag makes reloads tactical. Low fire rate fits CV aim (placing shots, not tracking sprays).
- **Recoil (client-side, visual):** each shot kicks camera pitch ~2° + tiny random yaw, decays back over ~150ms. Server raycasts the aim vector reported at fire time — rapid shots naturally drift because the view climbed. That's the skill curve, for free.
- **Rounds 60–90 seconds.** Short rounds fight arm fatigue and make great demo pacing.

---

## 2. The control scheme (FINAL — locked, pressure-tested)

### Foundational principle #1: torso-relative coordinates
All hand/lean inputs are computed **relative to the player's own torso (shoulder/hip frame), never the camera frame.** This is the most important code in the input system — it stops strafing from dragging your crosshair, stepping from triggering phantom strafes, and crouching from polluting aim.

### Foundational principle #2: state transitions over velocity
Detect gesture *state changes* (open→fist), never velocity estimates (jabs). Webcam depth velocity is noise; state transitions are robust.

### In-combat gestures (exactly five — never add a sixth)

| Input | Action | Detection notes |
|---|---|---|
| Aim hand open — center zone | Fine aim (absolute) | Wrist from pose model (stable); hand open/fist classifier throttled to ~10Hz |
| Aim hand open — edge zone | Turn view 360° | Dwell-before-engage to stop accidental turns; **re-zero on re-entry** to center zone (else crosshair lurches after every turn); max turn ~180–270°/s |
| Off-hand **squeeze** (open→fist transition) | Fire one shot | One squeeze = one shot; must reopen to fire again (natural ~3–4/s semi-auto cap) |
| Aim-hand fist, held 0.5s | Reload | Requires sustained high fist-confidence AND low hand velocity (kills the edge-on misread); auto-reload on empty makes manual rare |
| Lean torso (shoulders **offset from hips**) | Strafe L/R · walk fwd/back | Hip-relative = drift-immune. Fwd/back is **binary** (threshold → fixed walk speed), not analog |
| Shoulder dip ~15%, torso vertical | Crouch | Hysteresis: enter −15%, exit −8%. Modest dip keeps hands in frame (load-bearing design choice). Torso-angle check separates crouch from lean-forward |

### State-gated gestures (outside combat — false positives impossible)
- **Both arms raised, round-end state only** → Victory celebration (winner mirrors their character on the big screen).

### Pre-committed fallback
If lean-depth (walk fwd/back) is flaky, swap to **march-in-place = walk forward** (knee oscillation — bigger, cleaner signal). **Decision deadline: Friday midnight.** No 2am debates.

### Calibration screen (required, 3 seconds, doubles as tutorial)
On join: stand neutral → captures standing height, hip/shoulder baseline, aim-hand range. Includes a **crouched fit-check** ("dip — can we still see your hands?") and frame-fit guides. Every gesture's reliability depends on this baseline.

### HUD state strip
Always show what the camera thinks you're doing (aiming / firing / reloading / crouched / moving). Makes the controls feel trustworthy — straight UX points.

---

## 3. Architecture: predicted client, authoritative server

**SpacetimeDB is the game server.** Judges' test — "remove SpacetimeDB, is there a game?" Answer: **no.** No hit detection, no health, no match, no truth.

- **Client predicts** the feel: muzzle flash, hit spark, sound, recoil — instant on fire.
- **SpacetimeDB reducers decide reality:** `fire(aimVector)` raycasts server-side, applies damage, updates score. Client reconciles to the server's answer.
- **The real justification — anti-cheat:** in a webcam FPS, client-side hits could be trivially faked. Server-authoritative resolution can't be.

### Tables
| Table | Holds |
|---|---|
| `players` | id, name, position, aim vector, health, ammo, alive, anim state |
| `match` | round, score, timer, state machine (lobby → live → round-end → match-end) |
| `shots` | fire events + server hit/miss resolution |
| `spectators` | subscribers for the big-screen view |
| `leaderboard` | wins/losses across matches |
| `commentary` | next line for the AI caster |

### Functions
- `join(name)` / `submitInput(aim, lean, crouch)` / `fire(aimVector)` — input reducers
- `tick()` — scheduled reducer: round timers, win conditions, respawns
- `caster()` — procedure: reads live match state → LLM → writes commentary (**async — must never block tick()**)

**Pitch one-liner:** *"We don't run a game server. The database is the server. Every shot is resolved by a reducer — pull SpacetimeDB out and there's no hit detection, no match, no truth, and no way to cheat."*

---

## 4. Animations (Mixamo — list confirmed, see Mixamo-Animation-List.md)

**One character rig (X/Y Bot) for every clip. FBX → glTF. "In Place" checked on locomotion.**

- **Gesture-driven:** Pistol Idle (aim) · Pistol Walk / Walk Backward · Pistol Strafe L/R · Shooting Handgun (fire) · Reload (trimmed to ~0.7s — **the clip IS the fire-lockout timer**) · Standing→Crouch → Pistol Kneeling Idle → Crouch→Stand · Victory.
- **Server-driven (no gesture — free polish):** Round start → *Grabbing Pistol* on both characters (dramatic round-open). Hit confirmed → *Hit Reaction* flinch (sells the netcode). Kill → **directional death** matching the shot vector. Empty mag → auto-reload.
- **Skipped on purpose:** jump, sprint, melee/Pistol Whip (sixth combat gesture = false-positive risk; stretch only).

Crossfade clips (~0.15s) via AnimationMixer keyed off SpacetimeDB player state. Full-body switching — no upper/lower layering at hackathon fidelity.

---

## 5. The A+ layer — mass spectating + AI caster

- Match state lives in SpacetimeDB → it **streams to every subscriber for free**: the big screen AND every phone in the room (QR for phones, link for laptops).
- **Free-fly spectator mode (tiered):** default = fixed caster-cam angle (works instantly); touch the on-screen joystick and you detach into Minecraft-style free-fly through the arena. The camera is **purely local — spectators are read-only**, zero writes to the DB. Fifty free-flying spectators cost the database nothing; this is the scale demo a small match otherwise lacks. **Never add visible spectator ghosts** — that turns every spectator into a write stream.
- **AI caster — two-tier audio (latency-aware):** LLM+TTS latency is ~4–5s, so kills can't wait for it. Tier 1: **instant canned "barks"** — pre-generated TTS kill lines with the player name spliced in, fired directly off the kill feed with zero latency. Tier 2: the **LLM does color commentary** (momentum, trash talk by name, round recaps) where 4s of lag doesn't matter — reading live state from the DB. Meaningful LLM use, and in a 5v5 the caster is also what keeps the match *legible* to the room.
- Triple duty: Best Use of LLMs ($1K) + sponsor-tech scale showcase + room-wide spectacle.

---

## 6. Judging fit & prizes

| Criterion | How we win it |
|---|---|
| Innovation | Body-controlled FPS in a browser — nobody's seen it |
| UX | Calibration + HUD strip + absolute aim = pick-up-and-play in 5s; prediction keeps it responsive |
| Completeness | One gun, one mode, five gestures — tight enough to finish and polish |
| Sponsor tech | DB **is** the server; anti-cheat is the genuine reason |

**Targets:** Best Game ($1K) · Grand Prize ($3K) · Best Use of LLMs ($1K) · Best Student Team ($750). Ceiling ~$5,750.

---

## 7. The 42-hour schedule (with hard gates)

**Before doors (tonight, setup only — not code)**
ElevenLabs API key · Adobe login + download all Mixamo clips · SpacetimeDB account + CLI installed for everyone · LLM API keys · caster prompt drafted in a doc · hotspot tested. Every one of these done now is an hour person 3 gets back on Saturday.

**Friday night** *(realistically ~5 working hours after talks — protect the non-negotiables)*
- **First 30 min, whole team: the interface contract.** Agree the exact shape of `submitInput`, the `players` row, and anim-state enum before splitting up. Integration failures at the gate come from undefined interfaces, not missing features.
- SpacetimeDB module: tables + reducers skeleton. Control scheme is LOCKED (this doc).
- Build the **torso-relative coordinate util first** — everything depends on it.
- Port `PoseTracker` + worker from tennis repo. One player aiming a smoothed crosshair.
- **Non-negotiable test #1:** open hand rotated edge-on moving to frame edge — does reload misfire? If yes, redesign reload now.
- **Non-negotiable test #2 (midnight): lean-depth verdict** — keep or swap to march-in-place.
- Calibration screen v1 (may slip to Sat dawn without harm — the two tests may not).

**Saturday by NOON — THE GATE**
Two players, server-authoritative hits, client prediction, crisp aim, 360 turn, movement. *If it doesn't feel good by noon: stop adding, start polishing. Everything below is conditional.*

**Saturday — parallel track (AI/audio dev, starts MORNING, not night):** build the caster against **mock table data** — it only reads the DB, so it must never wait on the gate. The never-cut feature does not get scheduled last.

**Saturday afternoon**
Full match loop: health, rounds, win/lose, score. Crouch. Mixamo animations wired to state (Akhil). Recoil tuning. Person 3 drafts submission summary + docs in parallel.
**30-min team-mode design lock (whole team):** dead players auto-switch to spectator cam · auto-balance team assignment on join · spawn geometry for 10 · round length for a 10-player arena. Decide now, not at 3am.

**Saturday night**
Plug the caster into real state + ElevenLabs + big-screen + phone spectator view (free-fly joystick). Victory-arms moment. Directional deaths + hit flinches + round-start pistol grab.
**Open-floor session = the 5v5 dress rehearsal (TIME-BOXED: 90 min, ONE designated host while two keep building):** recruit 12 hackers (10 + 2 alternates) with their own laptops, min-spec check at recruitment (Chrome, recent laptop), run a real 5v5 on venue wifi, fix what breaks, get contact info and a commitment for the Sunday slot. Every match writes the leaderboard. **Record the demo video tonight** — the 5v5 with caster is your best footage and your catastrophic-failure backup.

**Sunday morning**
Leaderboard polish. **Pre-stage the demo:** the recruited 10 seated, joined, and calibrated BEFORE the judging slot — the demo clock starts with ten characters already in the arena, never with webcam debugging. **Rehearse cold twice** (8–9 AM, actual room, actual lighting, crowd behind on purpose). Assemble video + docs (drafted Saturday). Backup laptops + recorded video ready. Fallback ladder if players drop: 5v5 → 3v3 → 2v2 — the game doesn't care, the reducers are NvN.
- **10:00 AM: submit** (summary, video, GitHub, demo, documentation — all five).
- **12:00 PM: stage demo.** After the staged 5v5 round, **invite a judge to swap into a slot** (a teammate's slot is the designated swap-in). Calibration is 3 seconds — proving the pick-up-and-play claim on a judge's own body is the most persuasive moment available.

### Cut-if-behind (drop in order)
matchmaking/lobby → multiple concurrent matches → reconnect → free-fly joystick (fixed caster-cam stays) → manual reload (auto stays) → victory arms → fancy arena art.

### Never cut
crisp aim · server-authoritative hits + prediction · the spectator + AI caster moment.

---

## 8. Team (3)

1. **Akhil — CV & game feel:** torso-relative util, gesture detectors, aim tuning, recoil. *(Critical path — pair him Friday, don't silo him.)*
2. **Backend — SpacetimeDB:** schema (teams from hour one), reducers, tick loop, server raycasts, prediction/reconciliation (pairs with Akhil Sat AM for the gate).
3. **Frontend + AI:** calibration screen, HUD strip, join link/QR, health/kill feed/scoreboard, **spectator clients (big screen + phone free-fly joystick)**, two-tier caster (barks + LLM color) + ElevenLabs, demo rehearsal owner. *(Heaviest load on the team — that's why animation wiring went to Akhil and all account/key setup happens before doors. Caster MUST start Sat AM against mock data; free-fly is the first simplification if behind: fixed caster-cam only.)*

---

## 9. Risk register (from pressure tests)

| Risk | Mitigation |
|---|---|
| Aim jitter / lag | Torso-relative coords, wrist tracking, OneEuroFilter, deadzones; noon gate |
| Reload false positive (edge-on hand) | Sustained confidence + low velocity required; Friday-night test; fallback gesture ready |
| Server round-trip feels laggy | Client prediction + reconciliation (gate item) |
| Lean-depth unreliable | Binary threshold; march-in-place fallback, decided Fri midnight |
| Crouch loses hands from frame | Modest-dip design + crouched fit-check in calibration |
| Hand identity swap | Gestures on opposite sides of midline; continuity tracking |
| Crowd in camera frame | Largest/closest-person lock; rehearse with photobombers |
| CPU overload (MediaPipe + 9 animated characters per laptop in 5v5) | CV in worker, hand model at 10Hz, low-poly arena, cap pixel ratio, no crossfades on distant characters, benchmark on weakest laptop |
| Person 3 overload (heaviest role on a 3-person team) | Animation wiring moved to Akhil; all setup before doors; caster starts Sat AM vs mock data; free-fly is their first cut |
| Caster narrates the past (4–5s LLM+TTS lag) | Two-tier audio: instant canned barks off the kill feed + LLM color commentary where lag is harmless |
| Venue wifi | Test 10-client load at Sat-night rehearsal; hotspot backup; pre-rehearsed |
| 10-laptop variance (webcams, lighting, CPU) | Pre-recruit 12, test on THEIR laptops Sat night; min-spec check (Chrome, recent laptop); pre-stage before the slot; fallback ladder 5v5→3v3→2v2 |
| 5v5 illegible to the room | AI caster narrates + big-screen caster cam + kill feed; short rounds |
| LLM stalls game | `caster()` async, never blocks `tick()` |
| Arm fatigue | 60–90s rounds |
| Scope creep | Five combat gestures max; cut list; the noon gate |

---

## 10. The honest summary

A no-install, body-controlled team FPS in the browser — refereed by SpacetimeDB (remove it and there's no game; anti-cheat is why it must exist), demoed as a pre-staged **5v5 of ten real bodies in one authoritative world**, narrated by a two-tier AI caster reading live database state, while the whole room free-flies through the match on their phones and the persistent leaderboard shows every match played this weekend. The control scheme survived a full pressure test (five combat gestures, torso-relative everything, transitions over velocities, fallbacks pre-committed with deadlines), and the plan survived three: the remaining risks are operational, each with a named owner and mitigation.

Concept grade: **A+**. Plan-as-resourced: **A−** for a 3-person team. What decides it: the Saturday-noon gate (game feel) and person 3's Saturday (caster + spectators). Pass both, pre-stage Sunday cleanly, swap a judge into the match — and this is the strongest Grand Prize case in the building. Miss the gate, and the cut list still protects a Best Game + Best Student Team floor.
