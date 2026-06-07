// ─────────────────────────────────────────────────────────────────────────
// loadout.ts — which gun the LOCAL player has equipped.
//
// For now this is a tiny store flipped by a TEMPORARY debug key (G, see
// input.ts) so the golden gun + ray-gun-blast sound are demoable. Later, "who
// has the golden gun" becomes a real mechanic (a pickup / reward, not everyone)
// — when that lands, just call setVariant() from it and the viewmodel + shot
// sound follow automatically (Weapon reads `variant` for both).
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import type { GunVariant } from "../Gun";

interface Loadout {
  variant: GunVariant;
  setVariant(v: GunVariant): void;
  /** TEMP (debug): flip between the normal and golden gun. */
  toggleGolden(): void;
}

export const useLoadout = create<Loadout>((set) => ({
  variant: "normal",
  setVariant: (variant) => set({ variant }),
  toggleGolden: () => set((s) => ({ variant: s.variant === "golden" ? "normal" : "golden" })),
}));
