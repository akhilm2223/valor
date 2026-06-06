// Browser smoke test for the local FPS (?game). Boots the scene headlessly,
// captures runtime errors, screenshots, and exercises the REAL wired modules via
// the dev-only window.__mosh hook (raycast at a live bot, then 5 shots → death).
// Run: node scripts/smoke.mjs   (dev server must be on :5155)
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = "http://localhost:5155/?game";
const SHOT = "/tmp/mosh-game.png";

// Headless uses SwiftShader (logic-only; WebGL may not composite into the PNG).
// HEADED=1 opens a real window on the host GPU for true visual proof.
const headed = !!process.env.HEADED;
const browser = await chromium.launch(
  headed ? { headless: false } : { args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] },
);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const pageErrors = [];
const consoleErrors = [];
const failedUrls = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("response", (r) => {
  if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url()}`);
});
page.on("requestfailed", (r) => failedUrls.push(`FAILED ${r.url()}`));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 15000 });
// Let rapier WASM init, GLBs load, world register, bots spawn, a few frames run.
await page.waitForTimeout(5000);

const result = await page.evaluate(() => {
  const w = window.__mosh;
  if (!w) return { ok: false, reason: "window.__mosh missing (DevHook didn't run)" };
  const { useGame, transforms, raycastShot, combat, LOCAL_ID } = w;

  const entities = useGame.getState().entities;
  const ids = Object.keys(entities);
  const hasLocal = ids.includes(LOCAL_ID);
  const bots = ids.filter((id) => entities[id].isBot);

  // Point-blank raycast at a live bot to prove hitscan + capsuleFor + the BVH
  // registration are wired and the ray-vs-capsule routine works. Aim from 0.5m
  // in front of the bot's capsule center straight at it (short maxDist avoids
  // any distant wall winning).
  let rayHit = null;
  const b = bots[0];
  if (b) {
    const c = transforms[b].pos; // capsule center
    const origin = [c[0], c[1], c[2] + 0.5];
    const dir = [0, 0, -1];
    const hit = raycastShot(origin, dir, 1.0);
    rayHit = hit ? { kind: hit.kind, entityId: hit.entityId } : null;
  }

  // Full damage path on a different bot: 5 shots → dead at 0 HP.
  const target = bots[1] ?? bots[0];
  const before = { ...entities[target] };
  for (let i = 0; i < 5; i++) combat.applyDamage({ targetId: target, amount: 20, fromDir: [0, 0, -1], byId: LOCAL_ID });
  const after = useGame.getState().entities[target];

  // Objective render proof: force one render and read the renderer's draw stats
  // + a center-pixel sample. triangles>0 ⇒ the scene is genuinely drawing
  // geometry (independent of any compositor/screenshot capture quirk).
  // Read R3F's OWN last auto-rendered frame (NO manual gl.render here) — this is
  // exactly what the user sees. With the render-pass fix the buffer holds the
  // scene; before the fix it was blank/black.
  let render = null;
  try {
    const { gl } = w;
    const info = gl.info.render;
    const dctx = gl.getContext();
    const px = new Uint8Array(4);
    dctx.readPixels(Math.floor(dctx.drawingBufferWidth / 2), Math.floor(dctx.drawingBufferHeight / 2), 1, 1, dctx.RGBA, dctx.UNSIGNED_BYTE, px);
    const png = document.querySelector("canvas").toDataURL("image/png");
    render = { calls: info.calls, triangles: info.triangles, centerPixel: [px[0], px[1], px[2], px[3]], png };
  } catch (e) {
    render = { error: String(e) };
  }

  return {
    ok: true,
    ids,
    hasLocal,
    botCount: bots.length,
    localPos: transforms[LOCAL_ID]?.pos,
    bot1Pos: transforms[bots[0]]?.pos,
    rayHit,
    kill: { target, beforeHealth: before.health, afterHealth: after.health, afterAlive: after.alive },
    render,
  };
});

// Capture the actual WebGL drawing buffer (preserveDrawingBuffer in DEV) — this
// bypasses the OS compositor, which often yields black for accelerated canvases.
const png = result.render?.png;
if (typeof png === "string" && png.startsWith("data:image/png")) {
  writeFileSync(SHOT, Buffer.from(png.split(",")[1], "base64"));
} else {
  await page.screenshot({ path: SHOT });
}
delete result.render?.png; // keep console output readable
await browser.close();

console.log("── smoke result ─────────────────────────────");
console.log(JSON.stringify(result, null, 2));
console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
console.log("consoleErrors:", consoleErrors.length ? consoleErrors : "none");
console.log("failedRequests:", failedUrls.length ? failedUrls : "none");
console.log("screenshot:", SHOT);

// Exit non-zero on any hard failure so the run is gated.
const fatal =
  pageErrors.length > 0 ||
  !result.ok ||
  !result.hasLocal ||
  result.botCount < 3 ||
  !result.rayHit ||
  result.rayHit.kind !== "entity" ||
  result.kill.afterAlive !== false ||
  result.kill.afterHealth !== 0;
process.exit(fatal ? 1 : 0);
