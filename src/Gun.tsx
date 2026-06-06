import { useMemo } from "react";
import { RoundedBox } from "@react-three/drei";

// Three procedural guns built from primitives — no model files. All share one
// orientation: barrel-forward along -Z, grip down -Y, so when parented to a hand
// bone (or an FPP camera) the muzzle points where you look. `length` scales the
// whole gun in world units (the slide is ~`length` long).
//
// Material choices come straight from the Three.js PBR research:
//   • Metals (metalness>0) get ALL their colour from reflections, so the studio's
//     <Environment preset="city"> is what makes gold/steel look like metal at all
//     — without an envMap a metal renders near-black.
//   • Gold: metalness 1, low roughness (~0.18) + clearcoat for a lacquered sheen.
//   • Gunmetal vs polymer: the metalness CONTRAST (0.9 slide vs 0 grip) separates
//     the parts more than colour does.
//   • Blaster glow without postprocessing: high emissiveIntensity + toneMapped
//     OFF, so the renderer's tonemapper doesn't crush the neon toward white.
//   • RoundedBox over boxGeometry everywhere: a small bevel catches an edge
//     highlight on every part, which is what reads as "manufactured", not "cube".

export type GunVariant = "normal" | "golden" | "blaster";

type MatSpec = { physical?: boolean; props: Record<string, unknown> };

const PALETTES: Record<Exclude<GunVariant, "blaster">, { body: MatSpec; grip: MatSpec }> = {
  // Tactical: satin steel slide + matte polymer grip.
  normal: {
    body: { props: { color: "#2b2e33", metalness: 0.9, roughness: 0.45, envMapIntensity: 1 } },
    grip: { props: { color: "#17181b", metalness: 0, roughness: 0.82 } },
  },
  // Golden gun (Scaramanga-style): polished gold body, darker brushed-gold grip.
  golden: {
    body: {
      physical: true,
      props: { color: "#ffd27a", metalness: 1, roughness: 0.18, envMapIntensity: 1.3, clearcoat: 1, clearcoatRoughness: 0.12 },
    },
    grip: { props: { color: "#7a591a", metalness: 1, roughness: 0.5, envMapIntensity: 1.1 } },
  },
};

// Render the right material element for a spec (physical adds clearcoat).
function Mat({ m }: { m: MatSpec }) {
  return m.physical ? <meshPhysicalMaterial {...m.props} /> : <meshStandardMaterial {...m.props} />;
}

export function Gun({
  length = 0.22,
  variant = "normal",
  ...props
}: { length?: number; variant?: GunVariant } & React.ComponentProps<"group">) {
  // Derive every part from `length` so proportions hold at any scale.
  const d = useMemo(() => {
    const L = length;
    return {
      L,
      slideLen: L,
      slideH: L * 0.28,
      slideW: L * 0.22,
      barrelLen: L * 0.45,
      gripLen: L * 0.75,
      gripW: L * 0.2,
      gripThick: L * 0.26,
      triggerGuard: L * 0.18,
      r: L * 0.018, // bevel radius shared by RoundedBox parts
    };
  }, [length]);

  if (variant === "blaster") return <Blaster d={d} {...props} />;

  const pal = PALETTES[variant];
  return (
    <group {...props}>
      {/* Slide / upper receiver — the long top block, barrel pointing -Z */}
      <RoundedBox args={[d.slideW, d.slideH, d.slideLen]} radius={d.r} smoothness={4} creaseAngle={0.4} position={[0, 0, -d.slideLen * 0.1]} castShadow>
        <Mat m={pal.body} />
      </RoundedBox>

      {/* Ejection-port notch: a slightly darker inset box, offset out to avoid z-fight */}
      <RoundedBox args={[d.slideW * 1.02, d.slideH * 0.34, d.slideLen * 0.3]} radius={d.r * 0.6} smoothness={3} position={[0, d.slideH * 0.18, -d.slideLen * 0.05]} castShadow>
        <meshStandardMaterial color="#0c0d0f" metalness={0.6} roughness={0.6} />
      </RoundedBox>

      {/* Barrel muzzle poking out the front */}
      <mesh position={[0, d.slideH * 0.05, -d.slideLen * 0.6 - d.barrelLen / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[d.slideW * 0.32, d.slideW * 0.32, d.barrelLen, 16]} />
        <Mat m={pal.body} />
      </mesh>

      {/* Front + rear sights */}
      <RoundedBox args={[d.slideW * 0.18, d.slideH * 0.4, d.slideW * 0.2]} radius={d.r * 0.4} smoothness={2} position={[0, d.slideH * 0.6, -d.slideLen * 0.5]} castShadow>
        <Mat m={pal.body} />
      </RoundedBox>
      <RoundedBox args={[d.slideW * 0.5, d.slideH * 0.35, d.slideW * 0.2]} radius={d.r * 0.4} smoothness={2} position={[0, d.slideH * 0.6, d.slideLen * 0.42]} castShadow>
        <Mat m={pal.body} />
      </RoundedBox>

      {/* Grip — angled back and down, the part the hand wraps */}
      <RoundedBox args={[d.gripW, d.gripLen, d.gripThick]} radius={d.r} smoothness={4} creaseAngle={0.4} position={[0, -d.gripLen * 0.45, d.slideLen * 0.28]} rotation={[0.32, 0, 0]} castShadow>
        <Mat m={pal.grip} />
      </RoundedBox>

      {/* Trigger guard ring + trigger */}
      <mesh position={[0, -d.slideH * 0.9, d.slideLen * 0.05]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[d.triggerGuard, d.slideW * 0.08, 10, 20]} />
        <Mat m={pal.body} />
      </mesh>
      <mesh position={[0, -d.slideH * 0.9, d.slideLen * 0.05]} castShadow>
        <boxGeometry args={[d.slideW * 0.12, d.triggerGuard * 0.9, d.slideW * 0.1]} />
        <Mat m={pal.body} />
      </mesh>
    </group>
  );
}

// Sci-fi energy blaster: a chunkier dark-metal body with cyan energy accents that
// glow via emissive + toneMapped=false (no postprocessing needed), a translucent
// plasma core down the barrel, and an emitter ring at the muzzle.
function Blaster({ d, ...props }: { d: ReturnType<typeof gunDims> } & React.ComponentProps<"group">) {
  const shell = { color: "#15181c", metalness: 0.65, roughness: 0.42, envMapIntensity: 1.1 };
  const grip = { color: "#0e1013", metalness: 0.2, roughness: 0.85 };
  // The neon trick: bright emissive, untonemapped so it stays saturated and "hot".
  const energy = { color: "#02151b", emissive: "#21e6ff", emissiveIntensity: 2.8, toneMapped: false, metalness: 0.2, roughness: 0.4 };

  return (
    <group {...props}>
      {/* Main body — bigger, more angular than the pistol slide */}
      <RoundedBox args={[d.slideW * 1.25, d.slideH * 1.15, d.slideLen * 1.05]} radius={d.r * 1.3} smoothness={4} creaseAngle={0.4} position={[0, 0, -d.slideLen * 0.08]} castShadow>
        <meshStandardMaterial {...shell} />
      </RoundedBox>

      {/* Energy cell mounted on top */}
      <RoundedBox args={[d.slideW * 0.7, d.slideH * 0.55, d.slideLen * 0.45]} radius={d.r} smoothness={3} position={[0, d.slideH * 0.78, d.slideLen * 0.12]} castShadow>
        <meshStandardMaterial {...energy} />
      </RoundedBox>

      {/* Glowing accent strips along each side (offset out to avoid z-fighting) */}
      {[-1, 1].map((s) => (
        <RoundedBox key={s} args={[d.slideW * 0.06, d.slideH * 0.5, d.slideLen * 0.8]} radius={d.r * 0.3} smoothness={2} position={[s * d.slideW * 0.66, 0, -d.slideLen * 0.05]}>
          <meshStandardMaterial {...energy} />
        </RoundedBox>
      ))}

      {/* Barrel housing + translucent plasma core glowing down the bore */}
      <mesh position={[0, -d.slideH * 0.05, -d.slideLen * 0.6 - d.barrelLen / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[d.slideW * 0.42, d.slideW * 0.46, d.barrelLen, 18]} />
        <meshStandardMaterial {...shell} />
      </mesh>
      <mesh position={[0, -d.slideH * 0.05, -d.slideLen * 0.6 - d.barrelLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[d.slideW * 0.2, d.slideW * 0.2, d.barrelLen * 1.04, 16]} />
        <meshStandardMaterial {...energy} />
      </mesh>

      {/* Muzzle emitter ring */}
      <mesh position={[0, -d.slideH * 0.05, -d.slideLen * 0.6 - d.barrelLen]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[d.slideW * 0.4, d.slideW * 0.12, 12, 24]} />
        <meshStandardMaterial {...energy} />
      </mesh>

      {/* Grip */}
      <RoundedBox args={[d.gripW * 1.1, d.gripLen, d.gripThick * 1.05]} radius={d.r} smoothness={4} creaseAngle={0.4} position={[0, -d.gripLen * 0.45, d.slideLen * 0.3]} rotation={[0.3, 0, 0]} castShadow>
        <meshStandardMaterial {...grip} />
      </RoundedBox>

      {/* Trigger guard + trigger */}
      <mesh position={[0, -d.slideH * 0.95, d.slideLen * 0.06]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[d.triggerGuard, d.slideW * 0.09, 10, 20]} />
        <meshStandardMaterial {...shell} />
      </mesh>
    </group>
  );
}

// Type helper so <Blaster> can share the dims object shape.
function gunDims() {
  return {
    L: 0, slideLen: 0, slideH: 0, slideW: 0, barrelLen: 0,
    gripLen: 0, gripW: 0, gripThick: 0, triggerGuard: 0, r: 0,
  };
}
