// ─────────────────────────────────────────────────────────────────────────
// viewMode.ts — REMOVABLE first-person ⇄ third-person view toggle.
//
// This (plus ThirdPersonCam.tsx) is the only "dev / spectator" part of the
// animation feature. Deleting this file + ThirdPersonCam.tsx + their mount
// removes third-person entirely; the layer split, the local body, and the
// viewmodel (the MP-ready core) all stay and keep working in first-person.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

interface ViewMode {
  /** true = third-person camera, false = first-person. */
  third: boolean;
  toggle(): void;
}

export const useViewMode = create<ViewMode>((set) => ({
  third: false,
  toggle: () => set((s) => ({ third: !s.third })),
}));
