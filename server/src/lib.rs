use spacetimedb::{Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp};

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

const MAX_HEALTH: u8 = 100;
const SHOT_DAMAGE: u8 = 34; // 3-shot kill, leaves room for hit-feel tuning
const MAG_SIZE: u8 = 12;
const MAX_RANGE: f32 = 60.0;

const ROUND_LEN_MS: u64 = 75_000;
const ROUND_END_COOLDOWN_MS: i64 = 5_000; // post-round pause before auto-restart
const MATCH_LENGTH_ROUNDS: u32 = 5; // after this many rounds match ends (no auto-restart)

// Team spawn points (Z separates A from B; arena is roughly XY square at y=0).
const SPAWN_A: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 8.0 };
const SPAWN_B: Vec3 = Vec3 { x: 0.0, y: 0.0, z: -8.0 };

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
    pub fired_at: Timestamp,
}

#[spacetimedb::table(accessor = spectators, public)]
pub struct Spectator {
    #[primary_key]
    pub identity: Identity,
    pub joined_at: Timestamp,
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

    // If this identity already has a Player row, just update the name + revive.
    if let Some(p) = ctx.db.players().identity().find(me) {
        let team = p.team;
        ctx.db.players().id().update(Player {
            name,
            alive: true,
            health: MAX_HEALTH,
            ammo: MAG_SIZE,
            position: team_spawn(team),
            ..p
        });
        return;
    }

    // Auto-balance: count alive members per team, place on smaller side.
    let (a, b) = team_counts(ctx);
    let team = if a <= b { 0 } else { 1 };

    ctx.db.players().insert(Player {
        id: 0,
        identity: me,
        name,
        team,
        position: team_spawn(team),
        aim_vector: Vec3 { x: 0.0, y: 0.0, z: if team == 0 { -1.0 } else { 1.0 } },
        lean: Vec2::default(),
        crouch: false,
        health: MAX_HEALTH,
        ammo: MAG_SIZE,
        alive: true,
        anim_state: AnimState::Idle,
        kills: 0,
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

    ctx.db.players().id().update(Player {
        aim_vector: aim,
        lean,
        crouch,
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
    let mut best: Option<(u32, f32)> = None; // (victim_id, distance)
    for victim in ctx.db.players().iter() {
        if victim.id == shooter.id || victim.team == shooter.team || !victim.alive {
            continue;
        }
        let center = Vec3 {
            x: victim.position.x,
            y: victim.position.y + PLAYER_HEIGHT * 0.5,
            z: victim.position.z,
        };
        if let Some(t) = ray_sphere(origin, dir, center, PLAYER_RADIUS * 1.5) {
            if t <= MAX_RANGE && best.map_or(true, |(_, bt)| t < bt) {
                best = Some((victim.id, t));
            }
        }
    }

    let (hit, victim_id, damage) = match best {
        Some((vid, _)) => (true, Some(vid), SHOT_DAMAGE),
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
        if let Some(victim) = ctx.db.players().id().find(vid) {
            let new_health = victim.health.saturating_sub(damage);
            let now_alive = new_health > 0;
            ctx.db.players().id().update(Player {
                health: new_health,
                alive: now_alive,
                anim_state: if now_alive { AnimState::Hit } else { AnimState::Death },
                ..victim.clone()
            });

            if !now_alive {
                // Credit the shooter with a kill. Re-fetch in case ammo update above
                // already moved the row's stored version forward.
                if let Some(s) = ctx.db.players().id().find(shooter.id) {
                    let new_kills = s.kills.saturating_add(1);
                    ctx.db.players().id().update(Player {
                        kills: new_kills,
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
    // Integrate movement for every alive player.
    let players: Vec<Player> = ctx.db.players().iter().filter(|p| p.alive).collect();
    for p in players {
        if p.lean.x == 0.0 && p.lean.z == 0.0 {
            continue;
        }
        let speed = if p.crouch { CROUCH_SPEED } else { MOVE_SPEED };
        let dx = p.lean.x * speed * TICK_DT;
        let dz = p.lean.z * speed * TICK_DT;
        let new_pos = Vec3 {
            x: p.position.x + dx,
            y: p.position.y,
            z: p.position.z + dz,
        };
        ctx.db.players().id().update(Player {
            position: new_pos,
            ..p
        });
    }

    let Some(m) = ctx.db.game_match().id().find(0) else { return };

    match m.state {
        MatchState::Lobby => {
            // Auto-start a round once both teams have at least one live player.
            let (a_alive, b_alive) = team_counts(ctx);
            if a_alive >= 1 && b_alive >= 1 {
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
                    ctx.db.game_match().id().update(GameMatch {
                        state: MatchState::MatchEnd,
                        ..m
                    });
                } else {
                    start_round_impl(ctx);
                }
            }
        }
        MatchState::MatchEnd => {
            // Terminal state. A future `reset_match` reducer can re-enter Lobby.
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
        ctx.db.players().id().delete(p.id);
    }
}

// =============================================================================
// Helpers
// =============================================================================

fn team_spawn(team: u8) -> Vec3 {
    if team == 0 { SPAWN_A } else { SPAWN_B }
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
