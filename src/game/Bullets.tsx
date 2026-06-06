import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { InstancedMesh, Object3D, Raycaster, Vector3, Quaternion, BufferGeometry, Mesh } from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

// Accelerate raycasts against static world meshes (the arena). Patched once globally;
// meshes opt in by calling geometry.computeBoundsTree() (done in GameView on the arena).
(BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(Mesh.prototype as any).raycast = acceleratedRaycast;

const MAX_BULLETS = 64;
const MAX_IMPACTS = 32;
const BULLET_SPEED = 45; // m/s
const BULLET_LIFE = 2.0; // s

type Bullet = { pos: Vector3; vel: Vector3; life: number };
type Impact = { pos: Vector3; life: number };

// Module singletons so the Player can spawn without React state churn.
const bullets: Bullet[] = [];
const impacts: Impact[] = [];

export function spawnBullet(origin: Vector3, dir: Vector3) {
  if (bullets.length >= MAX_BULLETS) bullets.shift();
  bullets.push({ pos: origin.clone(), vel: dir.clone().normalize().multiplyScalar(BULLET_SPEED), life: BULLET_LIFE });
}

// Renders + simulates all live bullets and impact sparks. `colliders` is the arena
// group; bullets raycast against it and spark on hit.
export function Bullets({ colliders }: { colliders: React.RefObject<Object3D | null> }) {
  const bulletMesh = useRef<InstancedMesh>(null!);
  const impactMesh = useRef<InstancedMesh>(null!);
  const ray = useMemo(() => {
    const r = new Raycaster();
    (r as any).firstHitOnly = true;
    return r;
  }, []);
  const dummy = useMemo(() => new Object3D(), []);
  const dir = useMemo(() => new Vector3(), []);
  const quat = useMemo(() => new Quaternion(), []);
  const zAxis = useMemo(() => new Vector3(0, 0, 1), []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);

    // advance bullets, raycast the arena, spark + retire on hit / expiry
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const dist = b.vel.length() * dt;
      dir.copy(b.vel).normalize();
      let hit = false;
      if (colliders.current) {
        ray.set(b.pos, dir);
        ray.far = dist;
        const hits = ray.intersectObject(colliders.current, true);
        if (hits.length) {
          if (impacts.length >= MAX_IMPACTS) impacts.shift();
          impacts.push({ pos: hits[0].point.clone(), life: 0.25 });
          hit = true;
        }
      }
      if (hit) {
        bullets.splice(i, 1);
        continue;
      }
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) bullets.splice(i, 1);
    }

    // write bullet instance matrices
    const bm = bulletMesh.current;
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (i < bullets.length) {
        dummy.position.copy(bullets[i].pos);
        // orient the streak along its velocity (geometry is long on +Z)
        dir.copy(bullets[i].vel).normalize();
        quat.setFromUnitVectors(zAxis, dir);
        dummy.quaternion.copy(quat);
        dummy.scale.set(1, 1, 1);
      } else dummy.scale.setScalar(0);
      dummy.updateMatrix();
      bm.setMatrixAt(i, dummy.matrix);
    }
    bm.instanceMatrix.needsUpdate = true;

    // impacts: shrink + fade then retire
    for (let i = impacts.length - 1; i >= 0; i--) {
      impacts[i].life -= dt;
      if (impacts[i].life <= 0) impacts.splice(i, 1);
    }
    const im = impactMesh.current;
    for (let i = 0; i < MAX_IMPACTS; i++) {
      dummy.quaternion.identity();
      if (i < impacts.length) {
        dummy.position.copy(impacts[i].pos);
        dummy.scale.setScalar(0.06 + (0.25 - impacts[i].life) * 0.5); // expand as it fades
      } else dummy.scale.setScalar(0);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={bulletMesh} args={[undefined, undefined, MAX_BULLETS]} frustumCulled={false}>
        {/* long on +Z so it reads as a tracer streak when oriented to velocity */}
        <boxGeometry args={[0.05, 0.05, 0.7]} />
        <meshStandardMaterial color="#fff2a0" emissive="#ffd83a" emissiveIntensity={4} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={impactMesh} args={[undefined, undefined, MAX_IMPACTS]} frustumCulled={false}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshStandardMaterial color="#ffd27a" emissive="#ff8a1f" emissiveIntensity={4} toneMapped={false} transparent opacity={0.9} />
      </instancedMesh>
    </>
  );
}
