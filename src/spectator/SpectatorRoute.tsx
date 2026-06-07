// SpectatorRoute — picks which spectator view to render based on the URL hash.
//
//   #spectator          → fixed-angle CasterCam (default)
//   #spectator/freefly  → FreeFly (touch / drag-orbit + pinch-zoom)
//
// Wired up in src/main.tsx. Both routes are read-only and don't write back to
// the SpacetimeDB module.

import { useEffect, useState } from "react";
import { CasterCam } from "./CasterCam";
import { FreeFly } from "./FreeFly";

export function SpectatorRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (hash === "#spectator/freefly") return <FreeFly />;
  return <CasterCam />;
}
