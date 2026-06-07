// Shared touch detection. Used by FreeFly (footer hint) and SpectatorRoute
// (mobile/desktop branching).

export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "ontouchstart" in window ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
  );
}
