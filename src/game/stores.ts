// ─────────────────────────────────────────────────────────────────────────
// stores.ts — shared game state. Two stores + one plain mutable record.
//
//   • useControls — the input contract (Controls). Producer: input.ts (keyboard)
//     today, MediaPipe later. Consumers: PlayerController, Weapon.
//   • useGame     — DISCRETE entity state (health/ammo/alive/fireState) keyed by
//     id, plus a short event ring buffer the HUD reads for hitmarker/killfeed.
//   • transforms  — 60fps pos/yaw/speeds, a PLAIN object mutated in useFrame.
//     Deliberately NOT a store: writing it never re-renders React. Read it with
//     `transforms[id]` inside useFrame; never put it in component state.
//
// The mutators on useGame (`upsert`/`patch`/`pushEvent`) are the ONLY writers of
// discrete state — combat, weapon and bots all go through them so updates are
// observable by the HUD.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import {
  type Controls,
  type Entity,
  type GameEvent,
  type Transform,
  type Vec3,
  LOCAL_ID,
  MAX_HEALTH,
  MAG_SIZE,
} from "./contracts";

// ── useControls ──────────────────────────────────────────────────────────
const initialControls: Controls = {
  yawDelta: 0,
  pitchDelta: 0,
  moveForward: false,
  moveBack: false,
  strafeLeft: false,
  strafeRight: false,
  crouch: false,
  firePressed: false,
  reloadPressed: false,
  tracked: true,
};

export const useControls = create<Controls>(() => ({ ...initialControls }));

/** Merge a partial control update (used by input producers). */
export function setControls(patch: Partial<Controls>) {
  useControls.setState(patch);
}

// ── transforms (plain mutable record, NOT reactive) ─────────────────────
export const transforms: Record<string, Transform> = {};

export function makeTransform(pos: Vec3, yaw = 0): Transform {
  return { pos: [...pos] as Vec3, yaw, pitch: 0, forwardSpeed: 0, lateralSpeed: 0, grounded: true, crouchAmount: 0 };
}

// ── useGame ──────────────────────────────────────────────────────────────
const MAX_EVENTS = 16;

export interface GameStore {
  localId: string;
  entities: Record<string, Entity>;
  events: GameEvent[];
  /** Insert/replace an entity and seed its transform if missing. */
  upsert(e: Entity, pos?: Vec3, yaw?: number): void;
  remove(id: string): void;
  /** Patch discrete fields of one entity (no-op if it's gone). */
  patch(id: string, p: Partial<Entity>): void;
  /** Append a HUD event (hitmarker/killfeed), keeping the ring bounded. */
  pushEvent(e: GameEvent): void;
}

export const useGame = create<GameStore>((set) => ({
  localId: LOCAL_ID,
  entities: {},
  events: [],
  upsert(e, pos, yaw) {
    if (pos && !transforms[e.id]) transforms[e.id] = makeTransform(pos, yaw ?? 0);
    set((s) => ({ entities: { ...s.entities, [e.id]: e } }));
  },
  remove(id) {
    delete transforms[id];
    set((s) => {
      const next = { ...s.entities };
      delete next[id];
      return { entities: next };
    });
  },
  patch(id, p) {
    set((s) => {
      const cur = s.entities[id];
      if (!cur) return s;
      return { entities: { ...s.entities, [id]: { ...cur, ...p } } };
    });
  },
  pushEvent(e) {
    set((s) => ({ events: [...s.events, e].slice(-MAX_EVENTS) }));
  },
}));

/** Factory for a fresh full-health entity (bots and the local player). */
export function makeEntity(id: string, team: Entity["team"], url: string, isBot: boolean): Entity {
  return {
    id,
    team,
    isBot,
    url,
    health: MAX_HEALTH,
    alive: true,
    ammo: MAG_SIZE,
    reloading: false,
    fireState: "ready",
  };
}
