import { useMemo } from "react";
import { Shape, ExtrudeGeometry } from "three";

// Three procedural guns built in code — no model files. The big quality jump over
// stacked boxes (per the Three.js research): the slide and frame are EXTRUDED 2D
// PROFILES (THREE.Shape -> ExtrudeGeometry with small bevels) so the silhouette is
// a real gun outline whose every edge catches a highlight; the barrel is a turned
// cylinder; serrations + sights + trigger + guard + mag are small accent parts; and
// the look comes from 3-tone material contrast (metal slide / matte frame / dark
// machined accents), all lit by the studio's <Environment> envMap.
//
// Local frame (kept identical to the old gun so the hand-hold transform still fits):
// profile is authored X = length (muzzle at +X), Y = height, Z = width; the whole
// thing is then rotated +90° about Y so the barrel points -Z and the grip -Y, and
// scaled by `length`. Centered on the grip so it seats in the palm.

export type GunVariant = "normal" | "golden" | "blaster";

type MatSpec = { physical?: boolean; props: Record<string, unknown> };

const PALETTES: Record<GunVariant, { slide: MatSpec; frame: MatSpec; accent: MatSpec }> = {
  // Tactical: satin steel slide, matte polymer frame, near-black machined controls.
  normal: {
    slide: { props: { color: "#2a2d33", metalness: 0.92, roughness: 0.34, envMapIntensity: 1.1 } },
    frame: { props: { color: "#191a1d", metalness: 0.0, roughness: 0.86 } },
    accent: { props: { color: "#0b0c0e", metalness: 0.7, roughness: 0.3 } },
  },
  // Golden gun: polished gold slide (clearcoat sheen), brushed-gold frame, gold trim.
  golden: {
    slide: {
      physical: true,
      props: { color: "#ffd277", metalness: 1, roughness: 0.16, envMapIntensity: 1.35, clearcoat: 1, clearcoatRoughness: 0.1 },
    },
    frame: { props: { color: "#a9791f", metalness: 1, roughness: 0.5, envMapIntensity: 1.1 } },
    accent: { props: { color: "#5c4310", metalness: 1, roughness: 0.35, envMapIntensity: 1 } },
  },
  // (blaster handled by its own component — these values are unused for it)
  blaster: {
    slide: { props: { color: "#15181c", metalness: 0.7, roughness: 0.4 } },
    frame: { props: { color: "#0e1013", metalness: 0.3, roughness: 0.82 } },
    accent: { props: { color: "#02151b", emissive: "#22e0ff", emissiveIntensity: 3, toneMapped: false } },
  },
};

function Mat({ m }: { m: MatSpec }) {
  return m.physical ? <meshPhysicalMaterial {...m.props} /> : <meshStandardMaterial {...m.props} />;
}

// --- 2D profiles (authored in L=1 units, muzzle toward +X) -------------------

// Slide: long top block, chamfered front-top + rear corners (bevel rounds the rest).
function slideShape(): Shape {
  const s = new Shape();
  s.moveTo(0.06, 0.46);
  s.lineTo(1.0, 0.46); // bottom, out to muzzle
  s.lineTo(1.0, 0.575); // front face
  s.lineTo(0.965, 0.62); // front-top chamfer
  s.lineTo(0.2, 0.62); // flat slide top
  s.lineTo(0.14, 0.605); // rear-top chamfer
  s.lineTo(0.06, 0.55);
  s.lineTo(0.06, 0.46);
  return s;
}

// Frame + grip: dust cover under the barrel, raked grip, beavertail tang. The
// trigger guard is a separate ring (simpler + safer than a Shape hole). Frame top
// runs to 0.48 so it tucks UNDER the slide (0.46) — overlap, never coplanar.
function frameShape(): Shape {
  const s = new Shape();
  s.moveTo(1.0, 0.48); // front-top, under slide
  s.lineTo(1.0, 0.34); // muzzle underside (dust cover front)
  s.lineTo(0.52, 0.34); // dust cover bottom
  s.lineTo(0.49, 0.2); // step down toward trigger
  s.quadraticCurveTo(0.47, 0.08, 0.43, 0.02); // front grip strap
  s.lineTo(0.4, 0.0); // grip toe
  s.lineTo(0.13, 0.0); // grip base (mag well)
  s.quadraticCurveTo(0.07, 0.04, 0.085, 0.14); // heel
  s.lineTo(0.12, 0.31); // raked backstrap
  s.quadraticCurveTo(0.14, 0.42, 0.23, 0.48); // beavertail up to slide
  s.lineTo(1.0, 0.48); // frame top forward, close
  return s;
}

const EXTRUDE = { bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 2, curveSegments: 24, steps: 1 };

// Dispatcher — no hooks here, so swapping variants never changes hook order.
export function Gun({
  length = 0.22,
  variant = "normal",
  ...props
}: { length?: number; variant?: GunVariant } & React.ComponentProps<"group">) {
  if (variant === "blaster") return <Blaster length={length} {...props} />;
  return <Pistol length={length} variant={variant} {...props} />;
}

function Pistol({
  length = 0.22,
  variant,
  ...props
}: { length?: number; variant: Exclude<GunVariant, "blaster"> } & React.ComponentProps<"group">) {
  const pal = PALETTES[variant];

  const slideW = 0.125;
  const frameW = 0.135;
  const { slideGeo, frameGeo } = useMemo(() => {
    const slideGeo = new ExtrudeGeometry(slideShape(), { ...EXTRUDE, depth: slideW });
    slideGeo.translate(0, 0, -slideW / 2);
    const frameGeo = new ExtrudeGeometry(frameShape(), { ...EXTRUDE, depth: frameW });
    frameGeo.translate(0, 0, -frameW / 2);
    return { slideGeo, frameGeo };
  }, []);

  // Rear-slide cocking serrations: a raked row of thin grooves.
  const serrations = Array.from({ length: 6 }, (_, i) => 0.17 + i * 0.025);

  return (
    <group {...props}>
      {/* orient profile (muzzle +X) to barrel -Z / grip -Y, then scale + center on grip */}
      <group rotation={[0, Math.PI / 2, 0]} scale={length}>
        <group position={[-0.52, -0.26, 0]}>
          {/* Slide (metal) */}
          <mesh geometry={slideGeo} castShadow>
            <Mat m={pal.slide} />
          </mesh>
          {/* Frame + grip (matte/polymer) */}
          <mesh geometry={frameGeo} castShadow>
            <Mat m={pal.frame} />
          </mesh>

          {/* Barrel: turned cylinder poking past the muzzle, with a recessed crown */}
          <mesh position={[1.06, 0.52, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.052, 0.052, 0.14, 20]} />
            <Mat m={pal.accent} />
          </mesh>
          <mesh position={[1.13, 0.52, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.03, 0.03, 0.02, 16]} />
            <meshStandardMaterial color="#050506" metalness={0.4} roughness={0.7} />
          </mesh>

          {/* Trigger guard ring + trigger */}
          <mesh position={[0.46, 0.16, 0]} castShadow>
            <torusGeometry args={[0.085, 0.018, 10, 24]} />
            <Mat m={pal.frame} />
          </mesh>
          <mesh position={[0.46, 0.18, 0]} rotation={[0, 0, 0.3]} castShadow>
            <boxGeometry args={[0.02, 0.08, 0.03]} />
            <Mat m={pal.accent} />
          </mesh>

          {/* Cocking serrations (recessed dark grooves) */}
          {serrations.map((x) => (
            <mesh key={x} position={[x, 0.55, 0]} rotation={[0, 0, 0.32]}>
              <boxGeometry args={[0.012, 0.15, slideW + 0.004]} />
              <Mat m={pal.accent} />
            </mesh>
          ))}

          {/* Front + rear sights */}
          <mesh position={[0.95, 0.65, 0]} castShadow>
            <boxGeometry args={[0.03, 0.05, 0.03]} />
            <Mat m={pal.accent} />
          </mesh>
          <mesh position={[0.12, 0.66, 0]} castShadow>
            <boxGeometry args={[0.05, 0.05, 0.08]} />
            <Mat m={pal.accent} />
          </mesh>

          {/* Magazine baseplate poking below the grip */}
          <mesh position={[0.25, -0.02, 0]} castShadow>
            <boxGeometry args={[0.3, 0.05, frameW + 0.01]} />
            <Mat m={pal.accent} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

// --- Sci-fi energy blaster ---------------------------------------------------

// Angular body (hard chamfers, bevelSegments 1) with a glowing core down the
// barrel, vents, and a flared emitter. Neon reads without postprocessing via high
// emissiveIntensity + toneMapped=false.
function blasterBody(): Shape {
  const s = new Shape();
  s.moveTo(0.02, 0.3);
  s.lineTo(0.86, 0.3); // bottom
  s.lineTo(1.0, 0.4); // angled muzzle underside
  s.lineTo(1.0, 0.62);
  s.lineTo(0.74, 0.72); // raked top deck
  s.lineTo(0.2, 0.72);
  s.lineTo(0.06, 0.6);
  s.lineTo(0.02, 0.3);
  return s;
}

function Blaster({ length = 0.22, ...props }: { length?: number } & React.ComponentProps<"group">) {
  const shell = { color: "#14171b", metalness: 0.7, roughness: 0.4, envMapIntensity: 1.1, flatShading: true };
  const grip = { color: "#0d0f12", metalness: 0.25, roughness: 0.85 };
  const energy = { color: "#02151b", emissive: "#22e6ff", emissiveIntensity: 3, toneMapped: false, roughness: 0.4 };

  const W = 0.14;
  const bodyGeo = useMemo(() => {
    const g = new ExtrudeGeometry(blasterBody(), { depth: W, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 1, steps: 1, curveSegments: 4 });
    g.translate(0, 0, -W / 2);
    return g;
  }, []);
  const vents = [0.3, 0.36, 0.42];

  return (
    <group {...props}>
      <group rotation={[0, Math.PI / 2, 0]} scale={length}>
        <group position={[-0.5, -0.34, 0]}>
          {/* Main body */}
          <mesh geometry={bodyGeo} castShadow>
            <meshStandardMaterial {...shell} />
          </mesh>

          {/* Glowing core down the centerline, seen between the body and barrel */}
          <mesh position={[0.62, 0.51, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.05, 0.05, 0.5, 18]} />
            <meshStandardMaterial {...energy} />
          </mesh>

          {/* Barrel shroud + flared emitter ring at the muzzle */}
          <mesh position={[1.02, 0.51, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.075, 0.085, 0.22, 8]} />
            <meshStandardMaterial {...shell} />
          </mesh>
          <mesh position={[1.16, 0.51, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.07, 0.022, 8, 20]} />
            <meshStandardMaterial {...energy} />
          </mesh>

          {/* Top energy cell */}
          <mesh position={[0.5, 0.78, 0]} castShadow>
            <boxGeometry args={[0.34, 0.1, W * 0.7]} />
            <meshStandardMaterial {...energy} />
          </mesh>

          {/* Vents along the body */}
          {vents.map((x) => (
            <mesh key={x} position={[x, 0.5, 0]}>
              <boxGeometry args={[0.02, 0.28, W + 0.01]} />
              <meshStandardMaterial color="#02151b" emissive="#22e6ff" emissiveIntensity={2.2} toneMapped={false} />
            </mesh>
          ))}

          {/* Grip + trigger guard */}
          <mesh position={[0.34, 0.08, 0]} rotation={[0, 0, 0.26]} castShadow>
            <boxGeometry args={[0.16, 0.42, W * 0.85]} />
            <meshStandardMaterial {...grip} />
          </mesh>
          <mesh position={[0.5, 0.18, 0]} castShadow>
            <torusGeometry args={[0.085, 0.02, 10, 24]} />
            <meshStandardMaterial {...shell} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
