// ─────────────────────────────────────────────────────────────────────────
// combat.test.ts — headless proof of the LOCKED damage model (vitest, no
// renderer). Run with `npm test`. Makes "5 shots → dead, 4 → alive@20"
// deterministic without a browser.
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { computeDamage, combat } from "./combat";
import { useGame, makeEntity } from "./stores";
import { MAX_HEALTH, SHOT_DAMAGE, type Vec3 } from "./contracts";

const DIR: Vec3 = [0, 0, -1];

function shoot(targetId: string) {
  combat.applyDamage({ targetId, amount: SHOT_DAMAGE, fromDir: DIR, byId: "shooter" });
}

describe("computeDamage (pure)", () => {
  it("subtracts and clamps at 0", () => {
    expect(computeDamage(100, 20)).toEqual({ health: 80, dead: false });
    expect(computeDamage(20, 20)).toEqual({ health: 0, dead: true });
    expect(computeDamage(10, 20)).toEqual({ health: 0, dead: true });
  });
});

describe("applyDamage (store-wired, locked model)", () => {
  beforeEach(() => {
    useGame.setState({ entities: {}, events: [] });
    useGame.getState().upsert(makeEntity("bot1", "red", "/models/character_a.glb", true));
  });

  it("4 shots leaves the bot alive at 20 HP", () => {
    for (let i = 0; i < 4; i++) shoot("bot1");
    const e = useGame.getState().entities["bot1"];
    expect(e.alive).toBe(true);
    expect(e.health).toBe(MAX_HEALTH - 4 * SHOT_DAMAGE); // 20
  });

  it("the 5th shot kills the bot and emits one kill event", () => {
    for (let i = 0; i < 5; i++) shoot("bot1");
    const g = useGame.getState();
    expect(g.entities["bot1"].alive).toBe(false);
    expect(g.entities["bot1"].health).toBe(0);
    expect(g.entities["bot1"].respawnAt).toBeGreaterThan(0);
    expect(g.events.filter((e) => e.kind === "kill").length).toBe(1);
    expect(g.events.filter((e) => e.kind === "hit").length).toBe(4);
  });

  it("a dead bot takes no further damage", () => {
    for (let i = 0; i < 7; i++) shoot("bot1"); // 2 extra after death
    const g = useGame.getState();
    expect(g.entities["bot1"].health).toBe(0);
    expect(g.events.filter((e) => e.kind === "kill").length).toBe(1); // not re-killed
  });
});
