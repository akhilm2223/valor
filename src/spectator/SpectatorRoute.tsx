// SpectatorRoute — picks which spectator view to render.
//
//   #spectator                  → CasterCam (desktop fixed-angle)
//   #spectator on touch device  → MobileSpectator (phone ghost-cam)
//   #spectator?mobile=1         → MobileSpectator (desktop QA preview)
//   #spectator/freefly          → FreeFly (drei OrbitControls)
//
// Wired up in src/main.tsx. All variants are read-only.

import { useEffect, useState } from "react";
import { CasterCam } from "./CasterCam";
import { FreeFly } from "./FreeFly";
import { MobileSpectator } from "./MobileSpectator";
import { isTouchDevice } from "./touch";

export function SpectatorRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (hash === "#spectator/freefly") return <FreeFly />;

  const forceMobile = new URLSearchParams(window.location.search).has("mobile");
  if (isTouchDevice() || forceMobile) return <MobileSpectator />;

  return <CasterCam />;
}
