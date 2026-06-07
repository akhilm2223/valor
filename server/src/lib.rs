use spacetimedb::{Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp};
use std::collections::HashMap;

// =============================================================================
// Constants (mirror client-side numbers from GameView.tsx so server-authoritative
// movement matches what the player sees pre-reconcile).
// =============================================================================

const MOVE_SPEED: f32 = 3.6; // m/s, matches GameView MOVE_SPEED
const CROUCH_SPEED: f32 = 1.6; // m/s when crouched
const TICK_DT: f32 = 0.033; // 30Hz scheduled

const PLAYER_RADIUS: f32 = 0.35; // capsule radius for raycast
const PLAYER_HEIGHT: f32 = 1.8;
const HEAD_OFFSET_Y: f32 = 1.35; // raycast origin above feet (matches client muzzle)

const MAX_PLAYERS: usize = 4; // 2v2 cap; extra joiners become spectators
const WORLD_HALF: f32 = 40.0; // play stays within ±40 on X/Z (the carved plaza)
const MAX_HEALTH: u8 = 100;
const SHOT_DAMAGE: u8 = 34; // 3-shot kill, leaves room for hit-feel tuning
const MAG_SIZE: u8 = 12;
const MAX_RANGE: f32 = 60.0;

const ROUND_LEN_MS: u64 = 75_000;
const ROUND_END_COOLDOWN_MS: i64 = 5_000; // post-round pause before auto-restart
const MATCH_LENGTH_ROUNDS: u32 = 5; // after this many rounds match ends
const MATCH_END_COOLDOWN_MS: i64 = 8_000; // pause on the final scoreboard, then auto-reset to Lobby

// Golden Gun vote (spectator-driven special event).
const GOLDEN_VOTE_WINDOW_MS: i64 = 20_000; // 20s voting window
const GOLDEN_REVEAL_MS: i64 = 5_000; // 5s winner reveal before returning to Idle

// Team spawn points: OPPOSITE DIAGONAL CORNERS of the open plaza (kept from main).
const SPAWN_A: Vec3 = Vec3 { x: 8.0, y: 0.0, z: 8.0 };
const SPAWN_B: Vec3 = Vec3 { x: -8.0, y: 0.0, z: -8.0 };

// =============================================================================
// Shared types
// =============================================================================

#[derive(SpacetimeType, Clone, Copy, Debug, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(SpacetimeType, Clone, Copy, Debug, Default)]
pub struct Vec2 {
    pub x: f32,
    pub z: f32,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnimState {
    Idle,
    Walk,
    StrafeL,
    StrafeR,
    WalkBack,
    Crouch,
    Fire,
    Reload,
    Hit,
    Death,
    VictoryArms,
    GrabbingPistol,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchState {
    Lobby,
    Live,
    RoundEnd,
    MatchEnd,
}

// Golden Gun vote state machine, runs orthogonally to MatchState. Idle is the
// resting state — the broadcast + mobile spectator render nothing extra.
#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GoldenVoteState {
    #[default]
    Idle,
    Voting,
    Reveal,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommentaryKind {
    Bark,
    Color,
}

// =============================================================================
// Tables (Valor-plan.md §3 — teams from hour one)
// =============================================================================

#[spacetimedb::table(accessor = players, public)]
#[derive(Clone)]
pub struct Player {
    #[primary_key]
    #[auto_inc]
    pub id: u32,
    #[unique]
    pub identity: Identity,
    pub name: String,
    pub team: u8,
    pub position: Vec3,
    pub aim_vector: Vec3,
    pub lean: Vec2,
    pub crouch: bool,
    pub health: u8,
    pub ammo: u8,
    pub alive: bool,
    pub anim_state: AnimState,
    // Cumulative match kills for this player. Drives leaderboard team_a/b_kills.
    pub kills: u32,
    // Cumulative deaths this match (scoreboard K/D).
    pub deaths: u32,
    // Lobby ready-up gate: the match only starts once every connected player is
    // ready (and both teams have ≥1). Reset to false on (re)join and on return
    // to Lobby.
    pub ready: bool,
    // Golden Gun (spectator-voted). Inert in the game for now (Tier 3) — set by
    // the vote, cleared on death/disconnect; the field exists so bindings + the
    // spectator/broadcast UI compile and the vote resolves.
    pub has_golden_gun: bool,
}

// Singleton: id is always 0
#[spacetimedb::table(accessor = game_match, public)]
#[derive(Clone)]
pub struct GameMatch {
    #[primary_key]
    pub id: u32,
    pub round: u32,
    pub score_a: u32,
    pub score_b: u32,
    pub round_timer_ms: u64,
    pub state: MatchState,
    // When tick() flipped state to RoundEnd. tick() uses this for the 5s cooldown
    // before auto-calling start_round() again. Init=epoch (=0 micros).
    pub round_end_timestamp: Timestamp,
    // Golden Gun vote state. Defaults: Idle / 0 / 0. While Voting,
    // golden_vote_ends_at is the wall-clock micros-since-epoch at which tick()
    // tallies and flips to Reveal. While Reveal, golden_vote_ends_at is when
    // tick() flips back to Idle. winner_id == 0 means "no winner" (no votes).
    pub golden_vote_state: GoldenVoteState,
    pub golden_vote_ends_at: i64,
    pub golden_vote_winner_id: u32,
}

#[spacetimedb::table(accessor = shots, public)]
pub struct Shot {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub shooter_id: u32,
    pub aim_vector: Vec3,
    pub hit: bool,
    pub victim_id: Option<u32>,
    pub damage: u8,
    // True ONLY on the fatal shot. The kill feed + caster key off this so a
    // 3-hit kill counts once, not three times ("dying multiple times").
    pub killed: bool,
    pub fired_at: Timestamp,
}

#[spacetimedb::table(accessor = spectators, public)]
pub struct Spectator {
    #[primary_key]
    pub identity: Identity,
    pub joined_at: Timestamp,
}

// Golden Gun votes — one row per spectator who has cast a vote in the current
// cycle. PK on voter_identity gives us "one vote per voter, switchable"
// without extra bookkeeping (re-cast is an UPDATE). Cleared by
// start_golden_vote() at the beginning of each cycle and by on_disconnect()
// when a voter's tab closes.
#[spacetimedb::table(accessor = golden_votes, public)]
pub struct GoldenVote {
    #[primary_key]
    pub voter_identity: Identity,
    pub target_player_id: u32,
    pub cast_at: Timestamp,
}

#[spacetimedb::table(accessor = leaderboard, public)]
pub struct LeaderboardRow {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_round: u32,
    pub winning_team: u8,
    pub team_a_kills: u32,
    pub team_b_kills: u32,
    pub played_at: Timestamp,
}

#[spacetimedb::table(accessor = commentary, public)]
pub struct Commentary {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub kind: CommentaryKind,
    pub text: String,
    pub created_at: Timestamp,
}

// =============================================================================
// Scheduled tick (30Hz)
// =============================================================================

#[spacetimedb::table(accessor = tick_schedule, scheduled(tick))]
pub struct TickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

// =============================================================================
// Init
// =============================================================================

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.game_match().insert(GameMatch {
        id: 0,
        round: 0,
        score_a: 0,
        score_b: 0,
        round_timer_ms: 0,
        state: MatchState::Lobby,
        round_end_timestamp: Timestamp::from_micros_since_unix_epoch(0),
        golden_vote_state: GoldenVoteState::Idle,
        golden_vote_ends_at: 0,
        golden_vote_winner_id: 0,
    });

    let interval = spacetimedb::TimeDuration::from_micros(33_000);
    ctx.db.tick_schedule().insert(TickSchedule {
        scheduled_id: 0,
        scheduled_at: interval.into(),
    });
}

// =============================================================================
// join — idempotent. Auto-balances onto the smaller team.
// =============================================================================

#[spacetimedb::reducer]
pub fn join(ctx: &ReducerContext, name: String) {
    let me = ctx.sender();

    // Existing identity (reconnect / re-join from the lobby) → revive in place,
    // clear ready so they must ready-up again. No duplicate row, no team change.
    if let Some(p) = ctx.db.players().identity().find(me) {
        let team = p.team;
        ctx.db.players().id().update(Player {
            name,
            alive: true,
            health: MAX_HEALTH,
            ammo: MAG_SIZE,
            position: team_spawn(team),
            aim_vector: team_aim(team),
            ready: false,
            ..p
        });
        // No longer a spectator if they were one.
        ctx.db.spectators().identity().delete(me);
        return;
    }

    // 2v2 CAP: once the match is full, extra joiners become spectators (a row in
    // the spectators table) rather than a 5th fighter. They can watch; no Player
    // row means the client shows the spectator view.
    let (mut total_a, mut total_b) = (0u32, 0u32);
    for p in ctx.db.players().iter() {
        if p.team == 0 { total_a += 1 } else { total_b += 1 }
    }
    if (total_a + total_b) as usize >= MAX_PLAYERS {
        if ctx.db.spectators().identity().find(me).is_none() {
            ctx.db.spectators().insert(Spectator { identity: me, joined_at: ctx.timestamp });
        }
        return;
    }

    // Auto-balance onto the smaller side (no team picking).
    let team = if total_a <= total_b { 0 } else { 1 };

    ctx.db.players().insert(Player {
        id: 0,
        identity: me,
        name,
        team,
        position: team_spawn(team),
        aim_vector: team_aim(team),
        lean: Vec2::default(),
        crouch: false,
        health: MAX_HEALTH,
        ammo: MAG_SIZE,
        alive: true,
        anim_state: AnimState::Idle,
        kills: 0,
<<<<<<< C:/Users/akhil/AppData/Local/Temp/merged.rs
        deaths: 0,
        ready: false,
    });
}

// =============================================================================
// set_ready — lobby ready-up. The match starts only when every connected player
// is ready and both teams have ≥1 (see the tick Lobby branch). Lobby only.
// =============================================================================

#[spacetimedb::reducer]
pub fn set_ready(ctx: &ReducerContext, ready: bool) {
    let me = ctx.sender();
    let Some(m) = ctx.db.game_match().id().find(0) else { return };
    if m.state != MatchState::Lobby {
        return; // can only toggle ready in the lobby
    }
    if let Some(p) = ctx.db.players().identity().find(me) {
        ctx.db.players().id().update(Player { ready, ..p });
    }
}

// set_team — pick your side in the lobby (max 2 per team). Moves you to that
// team's spawn and clears ready. Lobby only.
#[spacetimedb::reducer]
pub fn set_team(ctx: &ReducerContext, team: u8) {
    let me = ctx.sender();
    let Some(m) = ctx.db.game_match().id().find(0) else { return };
    if m.state != MatchState::Lobby || team > 1 {
        return;
    }
    let Some(p) = ctx.db.players().identity().find(me) else { return };
    if p.team == team {
        return;
    }
    // 2-per-team cap.
    let mut count = 0u32;
    for q in ctx.db.players().iter() {
        if q.id != p.id && q.team == team {
            count += 1;
        }
    }
    if count >= 2 {
        return; // that side is full
    }
    ctx.db.players().id().update(Player {
        team,
        position: team_spawn(team),
        aim_vector: team_aim(team),
        ready: false,
        ..p
=======
        has_golden_gun: false,
>>>>>>> C:/Users/akhil/AppData/Local/Temp/his.rs
    });
}

// =============================================================================
// submit_input — per-tick player intent. Movement integrates in tick().
// =============================================================================

#[spacetimedb::reducer]
pub fn submit_input(
    ctx: &ReducerContext,
    aim: Vec3,
    lean: Vec2,
    crouch: bool,
    fire_pressed: bool,
    reload: bool,
) {
    let me = ctx.sender();
    let Some(p) = ctx.db.players().identity().find(me) else { return };
    if !p.alive {
        return;
    }

    let moving = lean.x.abs() > 0.05 || lean.z.abs() > 0.05;
    let next_state = if reload {
        AnimState::Reload
    } else if fire_pressed {
        AnimState::Fire
    } else if crouch {
        AnimState::Crouch
    } else if moving {
        // dominant direction picks the clip
        if lean.x.abs() > lean.z.abs() {
            if lean.x > 0.0 { AnimState::StrafeR } else { AnimState::StrafeL }
        } else if lean.z > 0.0 {
            AnimState::Walk
        } else {
            AnimState::WalkBack
        }
    } else {
        AnimState::Idle
    };

    // Reload refills the mag. The client times the reload (plays the animation,
    // locks out firing) and sends reload=true once it completes — including the
    // AUTO-reload it kicks off when the mag hits empty. Server just refills.
    let new_ammo = if reload && p.ammo < MAG_SIZE { MAG_SIZE } else { p.ammo };

    ctx.db.players().id().update(Player {
        aim_vector: aim,
        lean,
        crouch,
        ammo: new_ammo,
        anim_state: next_state,
        ..p
    });
}

// =============================================================================
// fire — server-authoritative raycast vs every alive enemy.
// =============================================================================

#[spacetimedb::reducer]
pub fn fire(ctx: &ReducerContext, aim_vector: Vec3) {
    let me = ctx.sender();
    // LIVE only — no shooting in the lobby, countdown, or between rounds, so the
    // round boundaries are crisp and a stray shot can't damage anyone off-clock.
    let Some(m) = ctx.db.game_match().id().find(0) else { return };
    if m.state != MatchState::Live {
        return;
    }
    let Some(shooter) = ctx.db.players().identity().find(me) else { return };
    if !shooter.alive || shooter.ammo == 0 {
        return;
    }

    // Decrement ammo regardless of hit
    let new_ammo = shooter.ammo - 1;
    ctx.db.players().id().update(Player {
        ammo: new_ammo,
        ..shooter.clone()
    });

    let dir = normalize(aim_vector);
    let origin = Vec3 {
        x: shooter.position.x,
        y: shooter.position.y + HEAD_OFFSET_Y,
        z: shooter.position.z,
    };

    // Raycast: find nearest hit among enemies (different team, alive, in range).
    // Sample THREE spheres up the body (feet / torso / head) so a body-aim shot
    // that lands a little high or low still connects — a single torso sphere made
    // hits feel like misses.
    let mut best: Option<(u32, f32)> = None; // (victim_id, distance)
    for victim in ctx.db.players().iter() {
        if victim.id == shooter.id || victim.team == shooter.team || !victim.alive {
            continue;
        }
        for band in [0.4f32, PLAYER_HEIGHT * 0.5, PLAYER_HEIGHT * 0.92] {
            let center = Vec3 {
                x: victim.position.x,
                y: victim.position.y + band,
                z: victim.position.z,
            };
            if let Some(t) = ray_sphere(origin, dir, center, PLAYER_RADIUS * 1.4) {
                if t <= MAX_RANGE && best.map_or(true, |(_, bt)| t < bt) {
                    best = Some((victim.id, t));
                }
            }
        }
    }

<<<<<<< C:/Users/akhil/AppData/Local/Temp/merged.rs
    // Apply damage and decide `killed` BEFORE inserting the shot, so the kill feed
    // can key off the one fatal shot instead of every hit.
    let mut hit = false;
    let mut victim_id: Option<u32> = None;
    let mut damage = 0u8;
    let mut killed = false;
    if let Some((vid, _)) = best {
        hit = true;
        victim_id = Some(vid);
        damage = SHOT_DAMAGE;
=======
    // Golden Gun: if the shooter has the gun, damage equals the victim's
    // current HP — instant kill regardless of remaining health. Otherwise
    // standard SHOT_DAMAGE applies. (Computed inline because we need the
    // victim's HP, which is looked up after the raycast resolves.)
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

    ctx.db.shots().insert(Shot {
        id: 0,
        shooter_id: shooter.id,
        aim_vector: dir,
        hit,
        victim_id,
        damage,
        fired_at: ctx.timestamp,
    });

    if let Some(vid) = victim_id {
>>>>>>> C:/Users/akhil/AppData/Local/Temp/his.rs
        if let Some(victim) = ctx.db.players().id().find(vid) {
            let new_health = victim.health.saturating_sub(SHOT_DAMAGE);
            let now_alive = new_health > 0;
            killed = !now_alive;
            ctx.db.players().id().update(Player {
                health: new_health,
                alive: now_alive,
                deaths: if killed { victim.deaths.saturating_add(1) } else { victim.deaths },
                anim_state: if now_alive { AnimState::Hit } else { AnimState::Death },
                // If the wielder dies, the Golden Gun is consumed.
                has_golden_gun: now_alive && victim.has_golden_gun,
                ..victim.clone()
            });
            if killed {
                // Credit the shooter with the kill (re-fetch: the ammo update above
                // already advanced this row's stored version).
                if let Some(s) = ctx.db.players().id().find(shooter.id) {
                    ctx.db.players().id().update(Player {
                        kills: s.kills.saturating_add(1),
                        ..s
                    });
                }
                ctx.db.commentary().insert(Commentary {
                    id: 0,
                    kind: CommentaryKind::Bark,
                    text: format!("{} drops {}", shooter.name, victim.name),
                    created_at: ctx.timestamp,
                });
            }
        }
    }

    ctx.db.shots().insert(Shot {
        id: 0,
        shooter_id: shooter.id,
        aim_vector: dir,
        hit,
        victim_id,
        damage,
        killed,
        fired_at: ctx.timestamp,
    });
}

// =============================================================================
// tick — 30Hz: integrate movement + advance match state machine.
//
// State machine:
//   Lobby     -> Live      auto when both teams have >=1 alive player
//   Live      -> RoundEnd  on team wipe or timer == 0 (writes leaderboard row)
//   RoundEnd  -> Live      auto after ROUND_END_COOLDOWN_MS (until MATCH_LENGTH)
//   RoundEnd  -> MatchEnd  if round count reached MATCH_LENGTH_ROUNDS
// =============================================================================

#[spacetimedb::reducer]
pub fn tick(ctx: &ReducerContext, _arg: TickSchedule) {
    let Some(m) = ctx.db.game_match().id().find(0) else { return };

    // Integrate movement ONLY while Live. Frozen in lobby / between rounds so the
    // round boundaries are crisp and players don't wander the arena pre-fight.
    if m.state == MatchState::Live {
        let players: Vec<Player> = ctx.db.players().iter().filter(|p| p.alive).collect();
        for p in players {
            if p.lean.x == 0.0 && p.lean.z == 0.0 {
                continue;
            }
            let speed = if p.crouch { CROUCH_SPEED } else { MOVE_SPEED };
            let dx = p.lean.x * speed * TICK_DT;
            let dz = p.lean.z * speed * TICK_DT;
            // Clamp to the plaza so nobody slides into the void (r≈40 keeps play
            // on the carved arena).
            let nx = (p.position.x + dx).clamp(-WORLD_HALF, WORLD_HALF);
            let nz = (p.position.z + dz).clamp(-WORLD_HALF, WORLD_HALF);
            ctx.db.players().id().update(Player {
                position: Vec3 { x: nx, y: p.position.y, z: nz },
                ..p
            });
        }
    }

<<<<<<< C:/Users/akhil/AppData/Local/Temp/merged.rs
=======
    let Some(m) = ctx.db.game_match().id().find(0) else { return };

    // Golden Gun vote state machine — runs orthogonally to round state. Both
    // transitions are time-driven; finalize_golden_vote handles tally + award.
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

    // Re-read in case finalize_golden_vote / reveal-end changed the row.
    let Some(m) = ctx.db.game_match().id().find(0) else { return };

>>>>>>> C:/Users/akhil/AppData/Local/Temp/his.rs
    match m.state {
        MatchState::Lobby => {
            // Start only when BOTH teams have a player AND everyone has readied up.
            let (a_alive, b_alive) = team_counts(ctx);
            if a_alive >= 1 && b_alive >= 1 && all_ready(ctx) {
                start_round_impl(ctx);
            }
        }
        MatchState::Live => {
            let new_timer = m.round_timer_ms.saturating_sub((TICK_DT * 1000.0) as u64);
            let (a_alive, b_alive) = team_counts(ctx);

            if a_alive == 0 || b_alive == 0 || new_timer == 0 {
                end_round(ctx, &m, a_alive, b_alive);
            } else {
                ctx.db.game_match().id().update(GameMatch {
                    round_timer_ms: new_timer,
                    ..m
                });
            }
        }
        MatchState::RoundEnd => {
            // After ROUND_END_COOLDOWN_MS, auto-start the next round unless the
            // match is over.
            let elapsed_ms = ctx
                .timestamp
                .time_duration_since(m.round_end_timestamp)
                .map(|d| d.to_micros() / 1_000)
                .unwrap_or(0);
            if elapsed_ms >= ROUND_END_COOLDOWN_MS {
                if m.round >= MATCH_LENGTH_ROUNDS {
                    // Stamp the entry time so the MatchEnd cooldown measures from
                    // NOW (the scoreboard pause), not from when RoundEnd started.
                    ctx.db.game_match().id().update(GameMatch {
                        state: MatchState::MatchEnd,
                        round_end_timestamp: ctx.timestamp,
                        ..m
                    });
                } else {
                    start_round_impl(ctx);
                }
            }
        }
        MatchState::MatchEnd => {
            // Self-healing: after a short scoreboard pause, auto-reset to Lobby so
            // the game loops forever instead of dead-ending (which is what left
            // maincloud stuck at "matchEnd 4-1" with nobody able to play). The
            // Lobby branch then auto-starts a fresh match once both teams are
            // populated. A manual `reset_match` reducer does the same on demand.
            let elapsed_ms = ctx
                .timestamp
                .time_duration_since(m.round_end_timestamp)
                .map(|d| d.to_micros() / 1_000)
                .unwrap_or(0);
            if elapsed_ms >= MATCH_END_COOLDOWN_MS {
                reset_match_impl(ctx);
            }
        }
    }
}

// =============================================================================
// Round control: `start_round` is the public reducer (idempotent — safe to call
// even if already Live). It just delegates to start_round_impl. The tick auto
// loop uses the same impl.
// =============================================================================

#[spacetimedb::reducer]
pub fn start_round(ctx: &ReducerContext) {
    start_round_impl(ctx);
}

// Public reducer: force the match back to a fresh Lobby (scores + round reset,
// everyone revived at spawn, kills cleared). The Lobby branch of the tick then
// auto-starts round 1 as soon as both teams have a live player. Safe to call any
// time — the client can wire this to a "Play again" button.
#[spacetimedb::reducer]
pub fn reset_match(ctx: &ReducerContext) {
    reset_match_impl(ctx);
}

fn reset_match_impl(ctx: &ReducerContext) {
    let Some(m) = ctx.db.game_match().id().find(0) else { return };
    ctx.db.game_match().id().update(GameMatch {
        round: 0,
        score_a: 0,
        score_b: 0,
        round_timer_ms: 0,
        state: MatchState::Lobby,
        round_end_timestamp: ctx.timestamp,
        ..m
    });
    // Revive everyone clean at their team spawn so the next round is fair.
    let players: Vec<Player> = ctx.db.players().iter().collect();
    for p in players {
        let team = p.team;
        ctx.db.players().id().update(Player {
            position: team_spawn(team),
            aim_vector: team_aim(team),
            health: MAX_HEALTH,
            ammo: MAG_SIZE,
            alive: true,
            anim_state: AnimState::Idle,
            kills: 0,
            deaths: 0,
            ready: false, // back in the lobby → must ready up again
            ..p
        });
    }
}

fn start_round_impl(ctx: &ReducerContext) {
    let Some(m) = ctx.db.game_match().id().find(0) else { return };

    // Idempotency: if we're already Live, do nothing. Lets the auto-trigger and
    // the manual reducer coexist without double-incrementing the round counter.
    if m.state == MatchState::Live {
        return;
    }

    // Respawn every player at their team spawn.
    let players: Vec<Player> = ctx.db.players().iter().collect();
    for p in players {
        let team = p.team;
        ctx.db.players().id().update(Player {
            position: team_spawn(team),
            aim_vector: team_aim(team),
            health: MAX_HEALTH,
            ammo: MAG_SIZE,
            alive: true,
            anim_state: AnimState::GrabbingPistol,
            ..p
        });
    }
    ctx.db.game_match().id().update(GameMatch {
        round: m.round + 1,
        round_timer_ms: ROUND_LEN_MS,
        state: MatchState::Live,
        ..m
    });
}

// Win-condition write: pick winner, bump match score, snapshot kills per team
// into a new `leaderboard` row, transition to RoundEnd.
fn end_round(ctx: &ReducerContext, m: &GameMatch, a_alive: u32, b_alive: u32) {
    let winning_team = if a_alive > b_alive { 0 } else { 1 };
    let (sa, sb) = (m.score_a, m.score_b);

    // Sum cumulative kills per team for the leaderboard snapshot.
    let mut team_a_kills: u32 = 0;
    let mut team_b_kills: u32 = 0;
    for p in ctx.db.players().iter() {
        if p.team == 0 {
            team_a_kills = team_a_kills.saturating_add(p.kills);
        } else {
            team_b_kills = team_b_kills.saturating_add(p.kills);
        }
    }

    ctx.db.game_match().id().update(GameMatch {
        score_a: if winning_team == 0 { sa + 1 } else { sa },
        score_b: if winning_team == 1 { sb + 1 } else { sb },
        round_timer_ms: 0,
        state: MatchState::RoundEnd,
        round_end_timestamp: ctx.timestamp,
        ..m.clone()
    });
    ctx.db.leaderboard().insert(LeaderboardRow {
        id: 0,
        match_round: m.round,
        winning_team,
        team_a_kills,
        team_b_kills,
        played_at: ctx.timestamp,
    });
}

// =============================================================================
// caster_input (unchanged) + connection hooks
// =============================================================================

#[spacetimedb::reducer]
pub fn caster_input(ctx: &ReducerContext, kind: CommentaryKind, text: String) {
    ctx.db.commentary().insert(Commentary {
        id: 0,
        kind,
        text,
        created_at: ctx.timestamp,
    });
}

// =============================================================================
// Spectators — anonymous read-only viewers. Idempotent join, explicit leave.
// Mobile spectator clients (`#spectator` on touch devices) call spectator_join
// on mount and spectator_leave on unmount. The disconnect hook is a safety net
// for tab-close cases where the leave reducer never fires.
//
// Invisibility invariant: the Spectator row carries only `identity` +
// `joined_at` — no position/aim/team. Player clients render from `players`
// only, so spectators never appear in any player's view.
// =============================================================================

#[spacetimedb::reducer]
pub fn spectator_join(ctx: &ReducerContext) {
    let me = ctx.sender();
    if ctx.db.spectators().identity().find(me).is_some() {
        return;
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

// =============================================================================
// Golden Gun vote — spectator-driven special event.
//
// Flow:
//   • Broadcast operator clicks "Start Golden Vote" -> start_golden_vote().
//   • Phone spectators tap a player chip -> cast_golden_vote(target_player_id).
//     PK on voter_identity makes the vote switchable (re-cast = update).
//   • tick() watches golden_vote_ends_at; when window expires, finalize() tallies
//     and awards has_golden_gun to the leader, transitioning to Reveal.
//   • After GOLDEN_REVEAL_MS, tick() flips back to Idle.
//   • Gun is consumed on the wielder's death (fire reducer + on_disconnect).
// =============================================================================

#[spacetimedb::reducer]
pub fn start_golden_vote(ctx: &ReducerContext) -> Result<(), String> {
    let Some(m) = ctx.db.game_match().id().find(0) else { return Err("no match".into()) };
    if m.state != MatchState::Live {
        return Err("vote only during Live rounds".into());
    }
    if m.golden_vote_state != GoldenVoteState::Idle {
        return Err("vote already in flight".into());
    }
    // Clear any leftover vote rows from a previous cycle.
    let stale: Vec<Identity> = ctx.db.golden_votes().iter().map(|v| v.voter_identity).collect();
    for id in stale {
        ctx.db.golden_votes().voter_identity().delete(id);
    }
    // Clear any stale gun flag (shouldn't happen, but defensive).
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

// Helper: tally votes, award gun to leader, transition Voting -> Reveal. Called
// from tick() when the voting window expires. Ties broken by lowest id
// (deterministic). Winner must still be alive at tally time; otherwise we
// pick the next-best living candidate. If no living candidate has votes,
// winner_id stays 0 ("NO WINNER" splash on the broadcast).
fn finalize_golden_vote(ctx: &ReducerContext, m: &GameMatch) {
    let mut tally: HashMap<u32, u32> = HashMap::new();
    for v in ctx.db.golden_votes().iter() {
        *tally.entry(v.target_player_id).or_insert(0) += 1;
    }
    let winner: Option<u32> = tally
        .into_iter()
        .filter(|(pid, _)| {
            ctx.db.players().id().find(*pid).map(|p| p.alive).unwrap_or(false)
        })
        // Highest vote count wins; ties broken by lowest player id.
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
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

#[spacetimedb::reducer(client_connected)]
pub fn on_connect(_ctx: &ReducerContext) {}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    // REMOVE the row, don't just mark it dead. Web clients usually reconnect
    // with a fresh Identity after a refresh, so `join` inserts a NEW row and the
    // old one would linger forever as a dead body — the client renders every
    // remote player regardless of `alive`, so those ghosts stack at the spawn
    // point and a clean 1v1 looks like "1v2" with everyone piled in one place.
    // Deleting keeps the players table to exactly who is currently connected, so
    // team auto-balance and rendering both stay honest.
    let me = ctx.sender();
    if let Some(p) = ctx.db.players().identity().find(me) {
<<<<<<< C:/Users/akhil/AppData/Local/Temp/merged.rs
        ctx.db.players().id().delete(p.id);
    }
    // Also drop them from the spectator table if they were watching.
    ctx.db.spectators().identity().delete(me);

    // Lobby rule: a 1v1 needs BOTH sides present. If someone leaves while a match
    // is in progress, abort it and drop back to a fresh Lobby — a quit/refresh is
    // NOT a round win, so we don't award it. Count rows (not alive) so a player
    // who's merely dead this round still holds their team. The remaining player
    // waits in Lobby; the tick auto-starts a new match when a 2nd player joins.
    if let Some(m) = ctx.db.game_match().id().find(0) {
        if m.state != MatchState::Lobby {
            let (mut a_rows, mut b_rows) = (0u32, 0u32);
            for p in ctx.db.players().iter() {
                if p.team == 0 { a_rows += 1 } else { b_rows += 1 }
            }
            if a_rows == 0 || b_rows == 0 {
                reset_match_impl(ctx);
            }
        }
=======
        ctx.db.players().id().update(Player {
            alive: false,
            // Disconnecting forfeits the gun, same as dying.
            has_golden_gun: false,
            ..p
        });
>>>>>>> C:/Users/akhil/AppData/Local/Temp/his.rs
    }
    ctx.db.spectators().identity().delete(me);
    // Drop any active golden-gun vote from this identity.
    ctx.db.golden_votes().voter_identity().delete(me);
}

// =============================================================================
// Helpers
// =============================================================================

fn team_spawn(team: u8) -> Vec3 {
    if team == 0 { SPAWN_A } else { SPAWN_B }
}

// Facing the arena centre from each corner spawn (normalized). Team A at (8,8)
// looks toward (-1,-1)/√2; team B at (-8,-8) looks toward (1,1)/√2. The client
// seeds its camera yaw from this on (re)spawn, so you face the fight, not a wall.
fn team_aim(team: u8) -> Vec3 {
    const INV_SQRT2: f32 = 0.70710677;
    if team == 0 {
        Vec3 { x: -INV_SQRT2, y: 0.0, z: -INV_SQRT2 }
    } else {
        Vec3 { x: INV_SQRT2, y: 0.0, z: INV_SQRT2 }
    }
}

fn team_counts(ctx: &ReducerContext) -> (u32, u32) {
    let mut a = 0u32;
    let mut b = 0u32;
    for p in ctx.db.players().iter() {
        if !p.alive {
            continue;
        }
        if p.team == 0 { a += 1 } else { b += 1 }
    }
    (a, b)
}

// True when there is at least one player and EVERY player has readied up — the
// gate for Lobby → first round.
fn all_ready(ctx: &ReducerContext) -> bool {
    let mut any = false;
    for p in ctx.db.players().iter() {
        any = true;
        if !p.ready {
            return false;
        }
    }
    any
}

fn normalize(v: Vec3) -> Vec3 {
    let len = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
    if len < 1e-6 {
        return Vec3 { x: 0.0, y: 0.0, z: 1.0 };
    }
    Vec3 { x: v.x / len, y: v.y / len, z: v.z / len }
}

/// Returns the nearest positive `t` along `dir` (unit) where the ray
/// from `origin` enters a sphere of radius `r` at `center`, or None.
fn ray_sphere(origin: Vec3, dir: Vec3, center: Vec3, r: f32) -> Option<f32> {
    let oc = Vec3 { x: origin.x - center.x, y: origin.y - center.y, z: origin.z - center.z };
    let b = oc.x * dir.x + oc.y * dir.y + oc.z * dir.z;
    let c = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - r * r;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let sqrt_d = disc.sqrt();
    let t1 = -b - sqrt_d;
    let t2 = -b + sqrt_d;
    if t1 > 0.0 { Some(t1) } else if t2 > 0.0 { Some(t2) } else { None }
}
