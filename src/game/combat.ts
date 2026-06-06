// ─────────────────────────────────────────────────────────────────────────
// combat.ts — the LOCAL authoritative damage sink (PASS 1).
//
// This is the local stand-in for the future SpacetimeDB `fire()` reducer. It is
// the SOLE owner of health subtraction, death, and respawn. Weapon code never
// decrements health itself — it calls `combat.applyDamage(...)`, exactly the
// shape that becomes a reducer call in PASS 2 (the `CombatSink` interface is the
// swap point, so the transport changes but call sites don't).
//
// Damage model is LOCKED in contracts.ts: 20 dmg/shot, 100 HP, 5 shots to kill.
// The pure arithmetic is `computeDamage` (unit-tested headlessly in
// combat.test.ts — no renderer needed); `applyDamage` wires it to the store and
// emits hit/kill events for the HUD.
// ─────────────────────────────────────────────────────────────────────────

import { type CombatSink, type DamageEvent, MAX_HEALTH, RESPAWN_MS } from "./contracts";
import { useGame } from "./stores";

/** Pure, side-effect-free damage resolution — the deterministic core. */
export function computeDamage(health: number, amount: number): { health: number; dead: boolean } {
  const next = Math.max(0, health - amount);
  return { health: next, dead: next <= 0 };
}

export const combat: CombatSink = {
  applyDamage({ targetId, amount, byId }: DamageEvent) {
    const g = useGame.getState();
    const target = g.entities[targetId];
    if (!target || !target.alive) return; // can't damage the missing or the dead

    const { health, dead } = computeDamage(target.health, amount);
    const t = Date.now();
    if (dead) {
      g.patch(targetId, { health: 0, alive: false, fireState: "ready", reloading: false, respawnAt: t + RESPAWN_MS });
      g.pushEvent({ kind: "kill", by: byId, on: targetId, t });
    } else {
      g.patch(targetId, { health });
      g.pushEvent({ kind: "hit", by: byId, on: targetId, t });
    }
  },
};

/** Per-frame respawn check — call once from GameScene's useFrame. Revives any
 *  entity whose respawn timer has elapsed at full health. */
export function tickCombat(now: number) {
  const g = useGame.getState();
  for (const e of Object.values(g.entities)) {
    if (!e.alive && e.respawnAt != null && now >= e.respawnAt) {
      g.patch(e.id, { alive: true, health: MAX_HEALTH, respawnAt: undefined });
    }
  }
}
