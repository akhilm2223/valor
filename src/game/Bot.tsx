// ─────────────────────────────────────────────────────────────────────────
// Bot.tsx — SHOOTABLE dummy targets (Agent F).
//
// Bots are the things the local player practices on for the milestone: they
// stand, gently patrol, hold a gun, and visibly COLLAPSE when you put 5 shots
// into them. They do NOT shoot back and they own NO Rapier physics — the
// hitscan is analytic ray-vs-capsule (hitscan.ts) reading `transforms[id]` via
// `capsuleFor`, so a bot only needs a live transform + a registered Entity.
//
// OWNERSHIP / CONTRACT (contracts.ts / stores.ts):
//   • <Bots/> SPAWNS N bots on mount: makeEntity(id,"red",url,true) →
//     useGame.upsert(e, centerPos, yaw). On unmount it remove()s each id.
//   • This file WRITES the bots' `transforms[id]` (pos = capsule CENTER, plus
//     signed forward/lateral speeds for the anim arbiter). It only READS
//     `entity.alive` — death/respawn is combat.ts's job (it flips alive and
//     resets health). When dead we freeze speeds → resolveAnimState → "death".
//   • It never picks a clip directly: resolveAnimState() is THE arbiter, and we
//     hand its result to AnimatedCharacter as `animState`.
//
// COORDINATE CONVENTION (the load-bearing bit):
//   `transforms[id].pos` is the capsule CENTER. AnimatedCharacter renders the
//   rig with FEET at its group origin. So for a bot standing on the floor:
//       feetY   = floorY
//       centerY = floorY + (CAPSULE.standHalfHeight + CAPSULE.radius)  // +0.9
//   We position the OUTER group (which we control) at FEET [x, floorY, z] and
//   write the CENTER [x, floorY+0.9, z] into transforms so the hit capsule lines
//   up with the rendered body. FLOOR_Y defaults to 0 and MAY NEED TUNING to the
//   real arena floor height in Phase 3 (browser eyeball).
//
// PER-FRAME (useFrame, no re-render): we read the bot's own transform, advance a
// gentle ±X patrol oscillation, write pos + signed speeds, copy pos→outer group
// (feet) and yaw→group.rotation.y. animState is held in React state and only
// setState'd when it CHANGES, so moving never re-renders the React tree.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Group } from "three";
import { Gun } from "../Gun";
import { AnimatedCharacter } from "./AnimatedCharacter";
import { CAPSULE, LOCAL_ID, resolveAnimState, type Vec3 } from "./contracts";
import { makeEntity, transforms, useGame } from "./stores";
import { raycastShot } from "./hitscan";
import { setEntityWalk } from "./sfx";

// Measured plaza floor (feet Y) of arena_opt.glb near the player spawn — the
// player capsule settles with feet at ~-3.76. Bots are placed on this same
// contiguous slab; the per-bot floor-cast refines each one but is deliberately
// SHORT and starts just above this level so firstHitOnly snaps to the plaza
// rather than punching through to a lower carved layer (the map has overhangs /
// layered floors — see Models.tsx).
const FLOOR_Y = -7.12;

/** Refine the arena floor Y under (x,z) by casting DOWN from just above the
 *  plaza onto the world BVH. Short range so it can't fall through to a lower
 *  layer. Only world hits count. Returns null if nothing is just below. */
function floorYAt(x: number, z: number): number | null {
  const hit = raycastShot([x, FLOOR_Y + 2.5, z], [0, -1, 0], 5);
  return hit && hit.kind === "world" ? hit.point[1] : null;
}
// Distance from feet to capsule center (so the hit capsule wraps the body).
const CENTER_OFFSET = CAPSULE.standHalfHeight + CAPSULE.radius; // 0.9
// Bot footsteps fall off to silence at this distance from the local player.
const BOT_WALK_MAX_DIST = 18; // m

// Patrol: gently slide ±AMPLITUDE on local X over PERIOD seconds so locomotion
// anim + moving-target hitscan both get exercised without the bot wandering off.
const PATROL_AMPLITUDE = 1.2; // metres each side of the home X (stay on the slab)
const PATROL_PERIOD = 4.0; // seconds for a full there-and-back cycle

// The player spawns at [12,_,-9.5] looking -Z; bots face roughly toward it.
const PLAYER_SPAWN: Vec3 = [12, -6, -9.5];

// Alternating character GLBs so the dummies aren't visually identical.
const CHARACTER_URLS = ["/models/character_b.glb", "/models/character_a.glb"] as const;

/** One spawned bot: id, the GLB to render, and its home (feet) position. */
interface BotSpec {
  id: string;
  url: string;
  home: Vec3; // feet position [x, FLOOR_Y, z]
  yaw: number; // body facing, radians about +Y
}

/** Yaw (about +Y) that points from `from` toward `to` in the XZ plane. yaw=0
 *  faces -Z (three's default forward), matching PlayerController's convention. */
function yawToward(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  // Forward at yaw is (-sin, 0, -cos); solve atan2 so the body faces the target.
  return Math.atan2(-dx, -dz);
}

/** Build the default 3-bot layout, spread in front of the player spawn. */
function defaultSpecs(count: number): BotSpec[] {
  // In FRONT of the player (spawn [12,_,-9.5], looking -Z = decreasing z), on the
  // flat -7.12 plaza, spread ~6 m apart so left/center/right are clearly distinct
  // targets (not a clump) for the aim-lock to pick between.
  const homes: Vec3[] = [
    [6, FLOOR_Y, -21], // left
    [12, FLOOR_Y, -23], // center (a touch further → triangle)
    [18, FLOOR_Y, -21], // right
  ];
  const specs: BotSpec[] = [];
  for (let i = 0; i < count; i++) {
    const home = homes[i % homes.length];
    // Offset extra bots beyond the first three so they don't overlap.
    const ring = Math.floor(i / homes.length);
    const pos: Vec3 = [home[0], home[1], home[2] - ring * 3];
    specs.push({
      id: `bot${i + 1}`,
      url: CHARACTER_URLS[i % CHARACTER_URLS.length],
      home: pos,
      yaw: yawToward(pos, PLAYER_SPAWN),
    });
  }
  return specs;
}

/**
 * Bots — the spawner. Registers `count` bots (default 3) into the stores on
 * mount and removes them on unmount, rendering a <BotActor/> for each.
 */
export function Bots({ count = 3 }: { count?: number }) {
  // The bot list is set once; it never changes after mount, so plain state.
  const [specs] = useState<BotSpec[]>(() => defaultSpecs(count));

  useEffect(() => {
    const game = useGame.getState();
    for (const s of specs) {
      // Snap each bot's feet onto the real arena floor under its XZ (auto-adapts
      // to the carved/uneven map); fall back to the constant if the ray misses.
      const fy = floorYAt(s.home[0], s.home[2]);
      if (fy != null) s.home[1] = fy;
      const center: Vec3 = [s.home[0], s.home[1] + CENTER_OFFSET, s.home[2]];
      game.upsert(makeEntity(s.id, "red", s.url, true), center, s.yaw);
    }
    return () => {
      const g = useGame.getState();
      for (const s of specs) g.remove(s.id);
    };
  }, [specs]);

  return (
    <>
      {specs.map((s) => (
        <BotActor key={s.id} spec={s} />
      ))}
    </>
  );
}

/**
 * BotActor — one bot's body. Owns the outer group it positions every frame from
 * `transforms[id]`, drives the patrol, and feeds resolveAnimState's result to
 * AnimatedCharacter. AnimatedCharacter is NOT a forwardRef, so we control the
 * wrapper group rather than passing it a ref.
 */
function BotActor({ spec }: { spec: BotSpec }) {
  const groupRef = useRef<Group>(null);
  const [animState, setAnimState] = useState<ReturnType<typeof resolveAnimState>>("idle");
  // Per-bot patrol clock (seconds), and whether the bot was alive last frame so
  // we can snap it home on the dead→alive (respawn) transition.
  const phase = useRef(0);
  const wasAlive = useRef(true);
  // Phase-offset each bot so they don't oscillate in lockstep.
  const startPhase = useMemo(() => Math.random() * PATROL_PERIOD, []);

  useFrame((_, dt) => {
    const group = groupRef.current;
    const t = transforms[spec.id];
    const e = useGame.getState().entities[spec.id];
    if (!group || !t || !e) return;

    const omega = (Math.PI * 2) / PATROL_PERIOD;

    if (e.alive) {
      // On respawn (dead → alive), reset to the home pose and clock.
      if (!wasAlive.current) phase.current = startPhase;
      phase.current += dt;

      const u = (phase.current + startPhase) * omega;
      // Position along the patrol line (signed offset from home on local X).
      const x = spec.home[0] + Math.sin(u) * PATROL_AMPLITUDE;
      // d/dt of the X offset = world-space velocity along +X.
      const vx = Math.cos(u) * PATROL_AMPLITUDE * omega;

      // Decompose world velocity into the bot's local forward/lateral axes so the
      // anim arbiter picks walk/strafe. yaw=0 faces -Z: forward=(-sin,0,-cos),
      // right=(cos,0,-sin). The patrol only moves on world X (vz = 0).
      const sy = Math.sin(t.yaw);
      const cy = Math.cos(t.yaw);
      t.forwardSpeed = vx * -sy; // fwd.x * vx
      t.lateralSpeed = vx * cy; // right.x * vx

      // Write the capsule CENTER (what hitscan reads).
      t.pos[0] = x;
      t.pos[1] = spec.home[1] + CENTER_OFFSET;
      t.pos[2] = spec.home[2];
    } else {
      // Dead: freeze in place so resolveAnimState returns "death" cleanly.
      t.forwardSpeed = 0;
      t.lateralSpeed = 0;
    }
    wasAlive.current = e.alive;

    // Copy transform → outer group: pos is the CENTER, the group origin is FEET.
    group.position.set(t.pos[0], t.pos[1] - CENTER_OFFSET, t.pos[2]);
    group.rotation.y = t.yaw;

    // Footsteps: loop while this bot walks, volume falling off linearly with
    // distance to the local player (silent past BOT_WALK_MAX_DIST).
    const speed = Math.hypot(t.forwardSpeed, t.lateralSpeed);
    const lp = transforms[LOCAL_ID]?.pos;
    let walkGain = 0;
    if (e.alive && speed > 0.5 && lp) {
      const dx = t.pos[0] - lp[0], dy = t.pos[1] - lp[1], dz = t.pos[2] - lp[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      walkGain = Math.max(0, 1 - dist / BOT_WALK_MAX_DIST);
    }
    setEntityWalk(spec.id, walkGain > 0.001, walkGain);

    // Resolve the clip; only re-render when it actually changes.
    const next = resolveAnimState(e, t);
    if (next !== animState) setAnimState(next);
  });

  // Stop this bot's footstep voice when it unmounts.
  useEffect(() => () => setEntityWalk(spec.id, false, 0), [spec.id]);

  return (
    <group ref={groupRef}>
      <AnimatedCharacter
        url={spec.url}
        height={1.8}
        animState={animState}
        hold={<Gun length={0.22} variant="normal" />}
      />
    </group>
  );
}
