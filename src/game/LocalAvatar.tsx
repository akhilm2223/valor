// ─────────────────────────────────────────────────────────────────────────
// LocalAvatar.tsx — the LOCAL player's full third-person body (Agent A).
//
// This is what OTHER players see (and what the 3rd-person camera shows): the
// local human rendered with the SAME animated rig as the bots, driven by the
// SAME arbiter. It is essentially BotActor specialised to LOCAL_ID, minus the
// patrol (PlayerController owns `transforms[LOCAL_ID]`) and PLUS a render-layer
// assignment so the player's own first-person camera never sees their body.
//
// OWNERSHIP / CONTRACT (contracts.ts / stores.ts):
//   • We OWN nothing in the stores — PlayerController seeds the local Entity and
//     writes `transforms[LOCAL_ID]` (pos = capsule CENTER, yaw, pitch, speeds,
//     grounded, crouchAmount) every frame. We only READ them.
//   • We never pick a clip: resolveAnimState() is THE arbiter; its result is fed
//     to AnimatedCharacter as `animState`, held in React state and only set on a
//     CHANGE so moving never re-renders the React tree.
//
// COORDINATE CONVENTION (same as Bot.tsx):
//   `transforms[LOCAL_ID].pos` is the capsule CENTER; AnimatedCharacter renders
//   the rig with FEET at its group origin. So we place the OUTER group at FEET
//   = [x, centerY − CENTER_OFFSET, z] where CENTER_OFFSET = standHalfHeight +
//   radius = 0.9. We IGNORE pitch — bodies yaw but don't pitch.
//
// LAYER SPLIT (layers.ts):
//   The whole avatar (rig + held gun) goes on LAYER_OWN_BODY. The FPS camera
//   renders {WORLD, VIEWMODEL} only, so it never shows this body; the 3rd-person
//   camera (and, in MP, remote viewers) render {WORLD, OWN_BODY} and DO. The rig
//   streams in via Suspense/useGLTF, so meshes appear a few frames after mount —
//   so we re-stamp the layer EVERY frame (it's a tiny rig, the traversal is
//   cheap) to catch async-loaded meshes a one-time effect would miss.
// ─────────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Group } from "three";
import { Gun } from "../Gun";
import { AnimatedCharacter } from "./AnimatedCharacter";
import { CAPSULE, LOCAL_ID, resolveAnimState } from "./contracts";
import { transforms, useGame } from "./stores";
import { LAYER_OWN_BODY, setLayerRecursive } from "./layers";
import { useLoadout } from "./loadout";

// Distance from feet to capsule center (so the rig's feet sit on the floor).
const CENTER_OFFSET = CAPSULE.standHalfHeight + CAPSULE.radius; // 0.9

/**
 * LocalAvatar — the local player's third-person body. Reactively reads the
 * local Entity (for its GLB url) and the equipped gun variant; positions an
 * outer group from `transforms[LOCAL_ID]` each frame; feeds resolveAnimState's
 * result to AnimatedCharacter; and keeps the whole rig on LAYER_OWN_BODY so the
 * player's own FPS camera never renders it. Renders null until PlayerController
 * has seeded the local Entity (which may be a frame late on mount).
 */
export function LocalAvatar() {
  const entity = useGame((s) => s.entities[LOCAL_ID]);
  const variant = useLoadout((s) => s.variant);

  const groupRef = useRef<Group>(null);
  const [animState, setAnimState] = useState<ReturnType<typeof resolveAnimState>>("idle");

  useFrame(() => {
    const group = groupRef.current;
    const t = transforms[LOCAL_ID];
    const e = useGame.getState().entities[LOCAL_ID];
    if (!group || !t || !e) return;

    // Keep the rig (and its async-streamed meshes + held gun) on OWN_BODY so the
    // FPS camera never shows it. Cheap re-stamp every frame catches new meshes.
    setLayerRecursive(group, LAYER_OWN_BODY);

    // pos is the capsule CENTER; the group origin is FEET. Bodies ignore pitch.
    group.position.set(t.pos[0], t.pos[1] - CENTER_OFFSET, t.pos[2]);
    group.rotation.y = t.yaw;

    // Resolve the clip; only re-render when it actually changes.
    const next = resolveAnimState(e, t);
    if (next !== animState) setAnimState(next);
  });

  // PlayerController seeds the local Entity on mount; render nothing until then.
  if (!entity) return null;

  return (
    <group ref={groupRef}>
      <AnimatedCharacter
        url={entity.url}
        height={1.8}
        animState={animState}
        hold={<Gun length={0.22} variant={variant} />}
      />
    </group>
  );
}
