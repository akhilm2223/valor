use spacetimedb::{Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp};

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
}

// Singleton: id is always 0
#[spacetimedb::table(accessor = game_match, public)]
pub struct GameMatch {
    #[primary_key]
    pub id: u32,
    pub round: u32,
    pub score_a: u32,
    pub score_b: u32,
    pub round_timer_ms: u64,
    pub state: MatchState,
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
// Init: insert singleton match row + schedule tick
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
    });

    // 30Hz tick = every ~33ms
    let interval = spacetimedb::TimeDuration::from_micros(33_000);
    ctx.db.tick_schedule().insert(TickSchedule {
        scheduled_id: 0,
        scheduled_at: interval.into(),
    });
}

// =============================================================================
// Reducers (stubs — Phase 1 implementation pass fills these in)
// =============================================================================

#[spacetimedb::reducer]
pub fn join(_ctx: &ReducerContext, _name: String) {
    // TODO: auto-balance team, insert Player row tied to ctx.sender identity,
    //       set initial position from team spawn.
}

#[spacetimedb::reducer]
pub fn submit_input(
    _ctx: &ReducerContext,
    _aim: Vec3,
    _lean: Vec2,
    _crouch: bool,
    _fire: bool,
    _reload: bool,
) {
    // TODO: look up player by ctx.sender identity, update lean/crouch/aim_vector.
    //       Movement is integrated in tick() from lean, not here.
}

#[spacetimedb::reducer]
pub fn fire(_ctx: &ReducerContext, _aim_vector: Vec3) {
    // TODO: server-side raycast against player capsules + arena boxes,
    //       insert Shot row, decrement victim health on hit,
    //       on kill update leaderboard + emit Bark commentary.
}

#[spacetimedb::reducer]
pub fn tick(_ctx: &ReducerContext, _arg: TickSchedule) {
    // TODO: integrate movement from per-player lean,
    //       advance round timer, evaluate win condition,
    //       respawn on round_start, drive MatchState machine.
}

#[spacetimedb::reducer]
pub fn caster_input(ctx: &ReducerContext, kind: CommentaryKind, text: String) {
    // Async caster lane writes here. Read by the TS client to drive audio.
    ctx.db.commentary().insert(Commentary {
        id: 0,
        kind,
        text,
        created_at: ctx.timestamp,
    });
}

// =============================================================================
// Connection hooks
// =============================================================================

#[spacetimedb::reducer(client_connected)]
pub fn on_connect(_ctx: &ReducerContext) {
    // No-op for now. Spectators are read-only (Valor-plan.md §5),
    // players call join() explicitly with their chosen name.
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    // Mark player dead so they free a slot. Match continues.
    let me = ctx.sender();
    if let Some(p) = ctx.db.players().identity().find(me) {
        ctx.db.players().id().update(Player {
            alive: false,
            ..p
        });
    }
}
