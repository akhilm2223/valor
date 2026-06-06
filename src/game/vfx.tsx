// ─────────────────────────────────────────────────────────────────────────
// vfx.tsx — procedural, pooled muzzle flash + tracer (no model files), per the
// Game-Logic-Deep-Dive §2 "Effects":
//   • Muzzle flash: additive emissive quad + a shared point light, ~45ms life,
//     random spin/scale, opacity = life/MUZZLE_MS.
//   • Tracer: thin stretched box muzzle→impact (oriented via lookAt), ~60ms
//     fade, pool of 16.
//   • Decals: intentionally CUT for the milestone (leak-prone, no gameplay value).
//
// Decoupled from the weapon via a module-singleton SINK (same pattern as
// combat.ts): the Weapon imports `vfx` and calls `vfx.muzzle(pos)` /
// `vfx.tracer(from,to)` on each shot; <Vfx/> (mounted once inside the Canvas)
// owns the pools and advances their lifetimes in useFrame. Effects requested
// before <Vfx/> mounts are simply dropped (no buffering needed).
// ─────────────────────────────────────────────────────────────────────────

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type PointLight,
  Vector3,
} from "three";
import type { Vec3 } from "./contracts";

const MUZZLE_MS = 45 / 1000; // seconds
const TRACER_MS = 60 / 1000;
const TRACER_POOL = 16;
const MUZZLE_POOL = 4;
const TRACER_THICKNESS = 0.02;

type MuzzleReq = { pos: Vec3 };
type TracerReq = { from: Vec3; to: Vec3 };

// Pending requests, drained by <Vfx/> on the next frame.
const pendingMuzzles: MuzzleReq[] = [];
const pendingTracers: TracerReq[] = [];

export interface VfxSink {
  muzzle(pos: Vec3): void;
  tracer(from: Vec3, to: Vec3): void;
}

export const vfx: VfxSink = {
  muzzle(pos) {
    pendingMuzzles.push({ pos });
  },
  tracer(from, to) {
    pendingTracers.push({ from, to });
  },
};

// Per-slot lifetime bookkeeping (parallel to the rendered pools).
type Slot = { life: number };

/** Pooled VFX renderer. Mount once inside the Canvas scene graph. */
export function Vfx() {
  const muzzleGroup = useRef<Group>(null);
  const tracerGroup = useRef<Group>(null);
  const light = useRef<PointLight>(null);
  const muzzleLife = useRef<Slot[]>(Array.from({ length: MUZZLE_POOL }, () => ({ life: 0 })));
  const tracerLife = useRef<Slot[]>(Array.from({ length: TRACER_POOL }, () => ({ life: 0 })));
  const tmpFrom = useRef(new Vector3());
  const tmpTo = useRef(new Vector3());

  useFrame((_, dt) => {
    const mg = muzzleGroup.current;
    const tg = tracerGroup.current;
    if (!mg || !tg) return;

    // ── spawn pending muzzles ───────────────────────────────────────────
    let lightLit = false;
    while (pendingMuzzles.length) {
      const req = pendingMuzzles.shift()!;
      const i = muzzleLife.current.findIndex((s) => s.life <= 0);
      if (i === -1) break; // pool exhausted this frame
      muzzleLife.current[i].life = MUZZLE_MS;
      const q = mg.children[i] as Mesh;
      q.position.set(req.pos[0], req.pos[1], req.pos[2]);
      q.rotation.z = Math.random() * Math.PI; // random spin
      const s = 0.18 + Math.random() * 0.12;
      q.scale.setScalar(s);
      q.visible = true;
      if (light.current) {
        light.current.position.set(req.pos[0], req.pos[1], req.pos[2]);
        light.current.intensity = 6;
        lightLit = true;
      }
    }

    // ── advance muzzle lifetimes ────────────────────────────────────────
    for (let i = 0; i < muzzleLife.current.length; i++) {
      const slot = muzzleLife.current[i];
      const q = mg.children[i] as Mesh;
      if (slot.life > 0) {
        slot.life -= dt;
        const t = Math.max(0, slot.life / MUZZLE_MS);
        (q.material as MeshBasicMaterial).opacity = t;
        if (slot.life <= 0) q.visible = false;
      }
    }
    if (light.current && !lightLit) {
      light.current.intensity = Math.max(0, light.current.intensity - dt * 120);
    }

    // ── spawn pending tracers ───────────────────────────────────────────
    while (pendingTracers.length) {
      const req = pendingTracers.shift()!;
      const i = tracerLife.current.findIndex((s) => s.life <= 0);
      if (i === -1) break;
      tracerLife.current[i].life = TRACER_MS;
      const box = tg.children[i] as Mesh;
      const from = tmpFrom.current.set(req.from[0], req.from[1], req.from[2]);
      const to = tmpTo.current.set(req.to[0], req.to[1], req.to[2]);
      const mid = from.clone().add(to).multiplyScalar(0.5);
      const len = from.distanceTo(to);
      box.position.copy(mid);
      box.lookAt(to); // box local -Z faces the impact
      box.scale.set(1, 1, Math.max(0.001, len));
      box.visible = true;
    }

    // ── advance tracer lifetimes ────────────────────────────────────────
    for (let i = 0; i < tracerLife.current.length; i++) {
      const slot = tracerLife.current[i];
      const box = tg.children[i] as Mesh;
      if (slot.life > 0) {
        slot.life -= dt;
        const t = Math.max(0, slot.life / TRACER_MS);
        (box.material as MeshBasicMaterial).opacity = t;
        if (slot.life <= 0) box.visible = false;
      }
    }
  });

  return (
    <group>
      <pointLight ref={light} color="#ffd9a0" intensity={0} distance={6} decay={2} />
      {/* Muzzle flash quads (additive, billboard-ish small planes). */}
      <group ref={muzzleGroup}>
        {Array.from({ length: MUZZLE_POOL }, (_, i) => (
          <mesh key={i} visible={false}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial color="#ffe6b0" transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      {/* Tracers: unit box stretched along local Z (length set per shot). */}
      <group ref={tracerGroup}>
        {Array.from({ length: TRACER_POOL }, (_, i) => (
          <mesh key={i} visible={false}>
            <boxGeometry args={[TRACER_THICKNESS, TRACER_THICKNESS, 1]} />
            <meshBasicMaterial color="#fff2c4" transparent opacity={0} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
