// ─────────────────────────────────────────────────────────────────────────
// PlayerController.tsx — the LOCAL player's movement + first-person camera.
//
// OWNS: the local player's Rapier kinematic capsule, the default R3F camera
// (drives its position+rotation every frame), and the authoritative write of
// `transforms[LOCAL_ID]`. Renders NO visible body — this is first-person, so
// the local character GLB is never shown (AnimatedCharacter skips LOCAL_ID).
//
// CONTRACT (contracts.ts / stores.ts):
//   • READS input ONLY from `useControls` — never the keyboard/DOM directly.
//     It is the sole CONSUMER of `yawDelta`/`pitchDelta`: it accumulates them
//     then ZEROES them back into the store each frame.
//   • WRITES `transforms[LOCAL_ID]` (a plain mutable record, NOT zustand) every
//     physics step: pos (capsule CENTER), yaw, pitch, signed forward/lateral
//     speeds (local-space, for the anim arbiter), grounded, crouchAmount.
//   • On mount, seeds the local Entity in `useGame` if absent (full health,
//     team "blue", character_a.glb, isBot=false).
//
// NON-OBVIOUS DECISIONS:
//   • Rapier's KCC has NO gravity — we integrate `vy` ourselves (GRAVITY,
//     terminal clamp) and zero it on contact, keeping a tiny downward "stick"
//     so snap-to-ground holds the player on slopes/steps.
//   • Wish-direction is camera-relative by YAW ONLY (flattened to XZ). Using
//     full camera pitch would drive movement into the floor when looking down.
//   • CapsuleCollider arg order is [halfHeight, radius] (Rapier's order, NOT
//     three's) — see contracts.CAPSULE.
//   • The character controller is created ONCE in an effect and REMOVED on
//     unmount: a leaked controller corrupts the WASM world across HMR reloads.
//   • All per-frame state lives in refs and store hot-paths are read via
//     getState() inside the physics step — this component never re-renders to
//     move, by design (split-by-frequency state model from contracts.ts).
//
// MILESTONE TODO: no stand-up ceiling shapecast — crouch->stand can clip a low
// ceiling. Acceptable for PASS 1; add a shapecast before un-shrinking later.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import {
  CapsuleCollider,
  RigidBody,
  useBeforePhysicsStep,
  useRapier,
  type RapierCollider,
  type RapierRigidBody,
} from "@react-three/rapier";
import { MathUtils, Vector3 } from "three";

// Derive the controller type from the world API so it resolves to the SAME
// rapier3d-compat copy @react-three/rapier bundles (importing the type from the
// top-level @dimforge package picks up a second copy and TS rejects the mix).
type KinematicCharacterController = ReturnType<
  ReturnType<typeof useRapier>["world"]["createCharacterController"]
>;
import { CAPSULE, LOCAL_ID, type Transform, type Vec3 } from "./contracts";
import { makeEntity, makeTransform, transforms, useControls, useGame } from "./stores";

// ── Tunables (movement research) ────────────────────────────────────────
const WALK_SPEED = 4.0; // m/s standing
const CROUCH_SPEED = 1.8; // m/s crouched
const ACCEL = 12.0; // horizontal velocity damping toward target (1/s)
const GRAVITY = -25.0; // m/s² (KCC has none; we integrate it)
const TERMINAL_VY = -40.0; // m/s clamp on downward velocity
const GROUND_STICK_VY = -1.0; // small downward bias while grounded (snap hold)
const PITCH_LIMIT = MathUtils.degToRad(88);
const SKIN = 0.01; // KCC skin offset
const AUTOSTEP_MAX = 0.5;
const AUTOSTEP_MIN_WIDTH = 0.2;
const SNAP_DIST = 0.3;
const MAX_SLOPE_CLIMB = MathUtils.degToRad(45);
const MIN_SLOPE_SLIDE = MathUtils.degToRad(30);
const CROUCH_LERP = 10.0; // crouch transition rate (1/s)
// Startup-race guard. The arena builds 80+ trimesh colliders over the first
// frames after the GLB mounts; the player spawns only ~0.2 m above the ground,
// so without this it free-falls through the not-yet-existent floor and is lost
// forever (the "gun keeps going down" bug). For SETTLE_TIME we hold gravity off
// so the floor can finish building, then drop normally. VOID_Y is a kill-plane
// far below the lowest arena ground (~-7.4): if we ever end up beneath it,
// hard-respawn at spawn. Together they make falling-out-of-world impossible.
const SETTLE_TIME = 1.0; // s — gravity held off after mount while colliders build
const VOID_Y = -25.0; // m — below this, respawn (no legit ground is this low)

export function PlayerController({ spawn = [0, 1.2, 6] as Vec3 }: { spawn?: Vec3 }) {
  const camera = useThree((s) => s.camera);
  const { world } = useRapier();

  const bodyRef = useRef<RapierRigidBody>(null);
  const colliderRef = useRef<RapierCollider>(null);
  const controllerRef = useRef<KinematicCharacterController | null>(null);

  // ── Per-frame mutable state (refs, never React state) ──────────────────
  const yaw = useRef(0);
  const pitch = useRef(0);
  const vy = useRef(0);
  const hvx = useRef(0); // horizontal world velocity X
  const hvz = useRef(0); // horizontal world velocity Z
  const halfHeight = useRef<number>(CAPSULE.standHalfHeight); // current (lerped) capsule half-height
  const crouchAmount = useRef(0); // 0..1
  const settle = useRef(SETTLE_TIME); // s left holding gravity off (startup-race guard)
  // The transform object we own and mutate in place (never reallocate).
  const tRef = useRef<Transform | null>(null);

  // Scratch vectors (avoid per-frame allocation).
  const camPos = useRef(new Vector3());
  const wish = useRef(new Vector3());
  const fwd = useRef(new Vector3());
  const right = useRef(new Vector3());

  // ── Seed entity + transform, init camera facing ────────────────────────
  useEffect(() => {
    const game = useGame.getState();
    if (!game.entities[LOCAL_ID]) {
      game.upsert(makeEntity(LOCAL_ID, "blue", "/models/character_a.glb", false), spawn, 0);
    }
    // Ensure a transform exists even if the entity was already present.
    if (!transforms[LOCAL_ID]) transforms[LOCAL_ID] = makeTransform(spawn, 0);
    tRef.current = transforms[LOCAL_ID];
    yaw.current = tRef.current.yaw;
    pitch.current = tRef.current.pitch;
    // spawn is the capsule CENTER; place the camera at center + standing eye.
    camera.position.set(spawn[0], spawn[1] + (CAPSULE.standEye - CAPSULE.standHalfHeight - CAPSULE.radius), spawn[2]);
    camera.rotation.order = "YXZ";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Create the kinematic character controller once; remove on unmount ──
  useEffect(() => {
    const c = world.createCharacterController(SKIN);
    c.enableAutostep(AUTOSTEP_MAX, AUTOSTEP_MIN_WIDTH, true);
    c.enableSnapToGround(SNAP_DIST);
    c.setMaxSlopeClimbAngle(MAX_SLOPE_CLIMB);
    c.setMinSlopeSlideAngle(MIN_SLOPE_SLIDE);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setApplyImpulsesToDynamicBodies(false);
    controllerRef.current = c;
    return () => {
      controllerRef.current = null;
      // Leaking a controller corrupts the WASM world on HMR — always remove it.
      world.removeCharacterController(c);
    };
  }, [world]);

  // ── Fixed-step movement (dt = world.timestep) ──────────────────────────
  useBeforePhysicsStep(() => {
    const rb = bodyRef.current;
    const collider = colliderRef.current;
    const controller = controllerRef.current;
    const t = tRef.current;
    if (!rb || !collider || !controller || !t) return;

    const dt = world.timestep;
    const ctrl = useControls.getState();

    // ── Startup-race + void guard (see SETTLE_TIME / VOID_Y) ─────────────
    if (settle.current > 0) settle.current -= dt;
    const here = rb.translation();
    if (here.y < VOID_Y) {
      // Fell out of the world (collider build race, or off an edge) — respawn.
      rb.setNextKinematicTranslation({ x: spawn[0], y: spawn[1], z: spawn[2] });
      vy.current = 0;
      settle.current = SETTLE_TIME; // give the floor a moment again
      return;
    }

    // ── Look: consume + zero the deltas (we are their sole consumer) ─────
    yaw.current = wrapAngle(yaw.current - ctrl.yawDelta);
    pitch.current = MathUtils.clamp(pitch.current - ctrl.pitchDelta, -PITCH_LIMIT, PITCH_LIMIT);
    if (ctrl.yawDelta !== 0 || ctrl.pitchDelta !== 0) {
      useControls.setState({ yawDelta: 0, pitchDelta: 0 });
    }

    // ── Crouch lerp (half-height + 0..1 amount) ──────────────────────────
    const crouchTarget = ctrl.crouch ? 1 : 0;
    crouchAmount.current = MathUtils.damp(crouchAmount.current, crouchTarget, CROUCH_LERP, dt);
    const targetHalf = MathUtils.lerp(CAPSULE.standHalfHeight, CAPSULE.crouchHalfHeight, crouchAmount.current);
    if (Math.abs(targetHalf - halfHeight.current) > 1e-5) {
      halfHeight.current = targetHalf;
      collider.setHalfHeight(targetHalf);
    }

    // ── Wish direction (camera-relative by YAW only, flattened to XZ) ────
    const cy = Math.cos(yaw.current);
    const sy = Math.sin(yaw.current);
    fwd.current.set(-sy, 0, -cy); // yaw=0 faces -Z (three default forward)
    right.current.set(cy, 0, -sy);
    const moveAxis = (ctrl.moveForward ? 1 : 0) - (ctrl.moveBack ? 1 : 0);
    const strafeAxis = (ctrl.strafeRight ? 1 : 0) - (ctrl.strafeLeft ? 1 : 0);
    wish.current
      .copy(fwd.current)
      .multiplyScalar(moveAxis)
      .addScaledVector(right.current, strafeAxis);
    if (wish.current.lengthSq() > 1e-6) wish.current.normalize();

    // ── Target horizontal velocity, damped ───────────────────────────────
    const speed = ctrl.crouch ? CROUCH_SPEED : WALK_SPEED;
    const tvx = wish.current.x * speed;
    const tvz = wish.current.z * speed;
    hvx.current = MathUtils.damp(hvx.current, tvx, ACCEL, dt);
    hvz.current = MathUtils.damp(hvz.current, tvz, ACCEL, dt);

    // ── Vertical: integrate our own gravity (KCC has none) ───────────────
    // While settling (startup), hold gravity off so the player rests at spawn
    // until the arena's trimesh floor has finished building (snap-to-ground
    // catches it the instant the colliders exist).
    if (settle.current > 0) vy.current = 0;
    else vy.current = Math.max(vy.current + GRAVITY * dt, TERMINAL_VY);

    // ── Compute + apply collider movement ────────────────────────────────
    const desired = { x: hvx.current * dt, y: vy.current * dt, z: hvz.current * dt };
    controller.computeColliderMovement(collider, desired);
    const move = controller.computedMovement();
    const grounded = controller.computedGrounded();

    const cur = rb.translation();
    const nx = cur.x + move.x;
    const ny = cur.y + move.y;
    const nz = cur.z + move.z;
    rb.setNextKinematicTranslation({ x: nx, y: ny, z: nz });

    if (grounded) vy.current = GROUND_STICK_VY; // hold the ground (snap stick)

    // ── Camera: capsule center + lerped eye height, YXZ from yaw/pitch ───
    const eye = MathUtils.lerp(CAPSULE.standEye, CAPSULE.crouchEye, crouchAmount.current);
    // eye is measured from feet; capsule center is half the full height above feet.
    const centerToEye = eye - (halfHeight.current + CAPSULE.radius);
    camPos.current.set(nx, ny + centerToEye, nz);
    camera.position.copy(camPos.current);
    camera.rotation.set(pitch.current, yaw.current, 0, "YXZ");

    // ── Write the shared transform (mutate in place) ─────────────────────
    t.pos[0] = nx;
    t.pos[1] = ny;
    t.pos[2] = nz;
    t.yaw = yaw.current;
    t.pitch = pitch.current;
    // Signed local-space horizontal speeds for the anim arbiter.
    t.forwardSpeed = hvx.current * fwd.current.x + hvz.current * fwd.current.z;
    t.lateralSpeed = hvx.current * right.current.x + hvz.current * right.current.z;
    t.grounded = grounded;
    t.crouchAmount = crouchAmount.current;
  });

  return (
    <RigidBody
      ref={bodyRef}
      type="kinematicPosition"
      colliders={false}
      position={spawn}
      enabledRotations={[false, false, false]}
    >
      <CapsuleCollider ref={colliderRef} args={[CAPSULE.standHalfHeight, CAPSULE.radius]} />
    </RigidBody>
  );
}

/** Wrap an angle into (-π, π] so accumulated yaw never drifts unbounded. */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}
