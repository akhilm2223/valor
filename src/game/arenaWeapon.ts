import { create } from "zustand";

// HUD-facing weapon state. Player drives the actual logic in refs (per-frame) and
// pushes ammo/reloading here only when they change, so the HUD re-renders rarely.
export const useWeapon = create<{ ammo: number; max: number; reloading: boolean }>(() => ({
  ammo: 12,
  max: 12,
  reloading: false,
}));
