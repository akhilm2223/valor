// ─────────────────────────────────────────────────────────────────────────
// contracts.ts — the FROZEN seams every game subsystem codes against.
//
// This file is the integration contract for the local (PASS 1) FPS. It is
// written in Phase 0 and is treated as immutable by the parallel agents that
// build movement, animation, hitscan, weapon, bots, HUD and combat. If a type
// here changes, every consumer must be re-checked — so it doesn't change.
//
// Two load-bearing design decisions live here:
//   1. SPLIT STATE BY UPDATE FREQUENCY. 60fps transforms (pos/yaw/speeds) live
//      in a plain mutable `transforms` record (see stores.ts) — never zustand —
//      so moving never triggers React re-renders. DISCRETE state (health, ammo,
//      alive, animState…) lives on `Entity` in the zustand `useGame` store.
//   2. ONE ANIM ARBITER. Movement, weapon and combat each WRITE inputs (speeds,
//      fireState, alive). Only `resolveAnimState` DECIDES the clip, and only
//      AnimatedCharacter READS it. No subsystem picks a clip directly.
//
// The damage model is LOCKED: 100 HP, 20 dmg/shot, 5 shots to kill, no hitboxes
// (a capsule hit is just a hit). `applyDamage` is behind the `CombatSink`
// interface so PASS 2 can swap the local impl for a SpacetimeDB reducer call.
// ─────────────────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

/** The local human player's stable id. Everything else is a bot for PASS 1. */
export const LOCAL_ID = "local";

// ── Damage model (LOCKED) ───────────────────────────────────────────────
export const MAX_HEALTH = 100;
export const SHOT_DAMAGE = 20; // 100 / 20 = 5 shots to kill
export const MAG_SIZE = 12;
export const RESPAWN_MS = 3000;

// ── Capsule geometry (shared by movement collider, hitscan, bots) ───────
// Rapier CapsuleCollider takes args [halfHeight, radius] (NOT three's order).
// Total height = 2*halfHeight + 2*radius → stand ≈ 1.8m, crouch ≈ 1.1m.
export const CAPSULE = {
  radius: 0.3,
  standHalfHeight: 0.6,
  crouchHalfHeight: 0.25,
  /** Eye height above feet when standing / crouched (camera + muzzle origin). */
  standEye: 1.5,
  crouchEye: 1.0,
} as const;

/** A capsule in world space: a core segment (base→tip) plus a radius. Both the
 *  KCC collider and the analytic ray-vs-capsule hitscan derive from this so a
 *  shot tests the exact volume the player occupies. */
export interface Capsule {
  base: Vec3; // bottom sphere center
  tip: Vec3; // top sphere center
  radius: number;
}

// ── Teams & entities ────────────────────────────────────────────────────
export type Team = "blue" | "red";

/** Weapon FSM phase (cosmetic — fire-rate is gated by a timer, not this). */
export type FireState = "ready" | "firing" | "reloading";

/** DISCRETE per-entity state. Lives in the zustand `useGame` store. Transforms
 *  (pos/yaw/speeds) are deliberately NOT here — see `Transform`. */
export interface Entity {
  id: string;
  team: Team;
  isBot: boolean;
  url: string; // character GLB to render
  health: number; // 0..MAX_HEALTH
  alive: boolean;
  ammo: number; // 0..MAG_SIZE
  reloading: boolean;
  fireState: FireState;
  /** Set by combat on kill; tickCombat() respawns when now >= respawnAt. */
  respawnAt?: number;
}

// ── 60fps transform (mutable ref store, NOT zustand) ────────────────────
export interface Transform {
  pos: Vec3;
  yaw: number; // radians about +Y (body facing)
  pitch: number; // radians (camera only; characters ignore pitch)
  forwardSpeed: number; // m/s, signed (+ forward) — drives locomotion anim
  lateralSpeed: number; // m/s, signed (+ right)
  grounded: boolean;
  crouchAmount: number; // 0..1
}

// ── Animation ────────────────────────────────────────────────────────────
export type AnimState =
  | "idle"
  | "walk"
  | "run"
  | "strafeLeft"
  | "strafeRight"
  | "crouchIdle"
  | "fire"
  | "reload"
  | "death";

/** GLB clip for each anim state. Agent B (AnimatedCharacter) preloads these and
 *  crossfades on state change. `idle` uses the gun-ready aiming pose. */
// The `?v=2` is a CACHE BUSTER. The first deploy was 41 MB and some clip GLBs
// got cached half-propagated (corrupt) by browsers/CDN. `must-revalidate` didn't
// dislodge them. Bumping the query string makes the URL "new" so every client
// fetches a clean copy. Bump again if a clip is ever cached bad in the future.
export const ANIM_CLIPS: Record<AnimState, string> = {
  idle: "/animations/aiming_idle.glb?v=2",
  walk: "/animations/walking.glb?v=2",
  run: "/animations/rifle_run.glb?v=2",
  strafeLeft: "/animations/strafe_left.glb?v=2",
  strafeRight: "/animations/strafe_right.glb?v=2",
  crouchIdle: "/animations/crouch_idle.glb?v=2",
  fire: "/animations/firing.glb?v=2",
  reload: "/animations/reloading.glb?v=2",
  death: "/animations/dying.glb?v=2",
};

/** Clips that play once (not looped) and that keep the hip Y-translation track
 *  (Agent B: death must drop the body — locomotion clips stay in-place). */
export const ONESHOT_CLIPS: ReadonlySet<AnimState> = new Set<AnimState>(["fire", "reload", "death"]);
export const ROOT_MOTION_CLIPS: ReadonlySet<AnimState> = new Set<AnimState>(["death"]);

const RUN_SPEED = 5.0; // m/s above which locomotion shows the run clip
const MOVE_EPS = 0.3; // m/s below which the entity is considered stationary

/** THE animation arbiter. Single source of truth for which clip plays.
 *  Priority: death > reload > fire > locomotion(strafe/run/walk) > crouch > idle.
 *  Full-body clips only (no upper/lower masking for the milestone), so firing
 *  while walking shows the fire clip. */
export function resolveAnimState(e: Entity, t: Transform): AnimState {
  if (!e.alive) return "death";
  if (e.reloading) return "reload";
  if (e.fireState === "firing") return "fire";
  const f = t.forwardSpeed;
  const l = t.lateralSpeed;
  const speed = Math.hypot(f, l);
  if (speed < MOVE_EPS) return t.crouchAmount > 0.5 ? "crouchIdle" : "idle";
  if (Math.abs(l) > Math.abs(f) + 0.1) return l > 0 ? "strafeRight" : "strafeLeft";
  return f > RUN_SPEED ? "run" : "walk";
}

// ── Input contract (keyboard now, MediaPipe later) ──────────────────────
// Movement/weapon code never knows the input source. `*Delta` are accumulated
// by the input producer and consumed-then-zeroed by PlayerController each frame.
// `firePressed`/`reloadPressed` are ONE-FRAME edge pulses: the producer sets
// them true; the SINGLE consumer (Weapon, in useFrame) reads and clears them.
export interface Controls {
  yawDelta: number;
  pitchDelta: number;
  moveForward: boolean;
  moveBack: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
  crouch: boolean;
  aiming: boolean; // held: scope / zoom in (vision: exactly one eye closed)
  firePressed: boolean;
  reloadPressed: boolean;
  tracked: boolean; // input source is live (always true for keyboard)
}

// ── Hitscan ──────────────────────────────────────────────────────────────
export interface HitResult {
  kind: "world" | "entity";
  point: Vec3;
  normal: Vec3;
  distance: number;
  entityId?: string; // set iff kind === "entity"
}

/** Resolve one shot: returns the NEAREST hit across BVH world geometry AND all
 *  enemy capsules (so a wall correctly blocks a bot behind it), or null on miss.
 *  Implemented by Agent E in hitscan.ts. */
export type RaycastShot = (origin: Vec3, dir: Vec3, maxDist: number) => HitResult | null;

// ── Combat sink (LOCKED model, swappable transport) ─────────────────────
export interface DamageEvent {
  targetId: string;
  amount: number;
  fromDir: Vec3; // shot direction, for directional death later
  byId: string;
}
export interface CombatSink {
  applyDamage(ev: DamageEvent): void;
}

// ── Game events (killfeed / hitmarker ring buffer for the HUD) ──────────
export type GameEvent =
  | { kind: "hit"; by: string; on: string; t: number }
  | { kind: "kill"; by: string; on: string; t: number };
