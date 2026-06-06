import { useMemo } from "react";

// Deterministic PRNG so the scatter is stable across reloads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Item = { pos: [number, number, number]; scale: number; rot: number };

// Scatter props in a ring around the town center (inner radius keeps the plaza clear).
function ring(count: number, inner: number, outer: number, seed: number): Item[] {
  const rnd = mulberry32(seed);
  const out: Item[] = [];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = inner + rnd() * (outer - inner);
    out.push({
      pos: [Math.cos(a) * r, 0, Math.sin(a) * r],
      scale: 0.7 + rnd() * 0.9,
      rot: rnd() * Math.PI * 2,
    });
  }
  return out;
}

// Low-poly cone+trunk tree and a boulder, no external assets. Fills the bare ground
// so the edges of the map read as a landscape instead of an empty plate.
export function Scatter() {
  const trees = useMemo(() => ring(80, 18, 70, 1337), []);
  const rocks = useMemo(() => ring(40, 14, 75, 4242), []);

  return (
    <group>
      {trees.map((t, i) => (
        <group key={`t${i}`} position={t.pos} rotation={[0, t.rot, 0]} scale={t.scale}>
          <mesh position={[0, 0.6, 0]} castShadow>
            <cylinderGeometry args={[0.12, 0.18, 1.2, 6]} />
            <meshStandardMaterial color="#6b4a2b" roughness={1} />
          </mesh>
          <mesh position={[0, 1.9, 0]} castShadow>
            <coneGeometry args={[0.9, 2.4, 7]} />
            <meshStandardMaterial color="#3f6b32" roughness={1} />
          </mesh>
        </group>
      ))}
      {rocks.map((r, i) => (
        <mesh key={`r${i}`} position={[r.pos[0], 0.2, r.pos[2]]} rotation={[r.rot, r.rot, 0]} scale={r.scale} castShadow receiveShadow>
          <dodecahedronGeometry args={[0.5, 0]} />
          <meshStandardMaterial color="#7a756c" roughness={1} flatShading />
        </mesh>
      ))}
    </group>
  );
}
