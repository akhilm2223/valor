import { chromium } from "playwright";

const URL = "https://valor-akhil-1v1.surge.sh/#multiplayer";

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader", // software WebGL so headless can render
  ],
});
const ctx = await browser.newContext({
  permissions: ["camera", "microphone"],
  viewport: { width: 1280, height: 720 },
});
const page = await ctx.newPage();

const log = [];
page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") log.push(`[${t}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("requestfailed", (r) =>
  log.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`),
);
// Track asset (model/animation) loads + statuses.
const assetReqs = new Map();
const isAsset = (u) => /\/(models|animations)\//.test(u);
page.on("request", (r) => { if (isAsset(r.url())) assetReqs.set(r.url(), "PENDING"); });
page.on("response", (r) => { if (isAsset(r.url())) assetReqs.set(r.url(), `HTTP ${r.status()}`); });
page.on("requestfinished", (r) => { if (isAsset(r.url()) && assetReqs.get(r.url()) === "PENDING") assetReqs.set(r.url(), "FINISHED"); });

console.log("→ loading", URL);
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(7000);
await page.screenshot({ path: "diag1-before-join.png" });

// Canvas-in-front BEFORE join → shows Arena/Scatter at the DEFAULT camera
// [0,3,12]. If the arena is visible here, the world renders fine and the blank
// after-join screen is purely the camera being moved to an empty spawn.
await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (c) { c.style.position = "fixed"; c.style.zIndex = "999999"; c.style.left = "0"; c.style.top = "0"; }
});
await page.waitForTimeout(1500);
await page.screenshot({ path: "diag1b-canvas-default-cam.png" });
await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (c) { c.style.position = ""; c.style.zIndex = ""; c.style.left = ""; c.style.top = ""; }
});

// Join flow
try {
  await page.fill('input[placeholder="Your name"]', "PWTester", { timeout: 8000 });
  await page.waitForSelector('button:has-text("Join")', { timeout: 10000 });
  await page.click('button:has-text("Join")', { timeout: 8000 });
  console.log("→ clicked Join");
} catch (e) {
  log.push(`[joinflow] ${e.message.slice(0, 200)}`);
}
await page.waitForTimeout(10000);
await page.screenshot({ path: "diag2-after-join.png" });

// Screenshot ONLY the canvas (bypasses the calibration overlay) to see the
// actual 3D render, and sample pixels to confirm geometry (not just flat sky).
try {
  await page.locator("canvas").screenshot({ path: "diag3-canvas.png" });
} catch (e) {
  log.push(`[canvasshot] ${e.message.slice(0, 150)}`);
}
const pixels = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return "no canvas";
  // Read a grid of pixels off a 2D copy to see colour variety = geometry present.
  const tmp = document.createElement("canvas");
  tmp.width = c.width; tmp.height = c.height;
  tmp.getContext("2d").drawImage(c, 0, 0);
  const g = tmp.getContext("2d");
  const colors = new Set();
  for (let y = 0; y < c.height; y += 40)
    for (let x = 0; x < c.width; x += 40) {
      const d = g.getImageData(x, y, 1, 1).data;
      colors.add(`${d[0]>>4},${d[1]>>4},${d[2]>>4}`);
    }
  return `distinct colour buckets in render: ${colors.size} (1-2 = blank sky, many = geometry)`;
});
console.log("\n=== CANVAS PIXELS ===\n" + pixels);

// Bring the WebGL canvas in FRONT of the calibration overlay so we can see the
// actual 3D render (overlays normally cover it).
await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (c) {
    c.style.position = "fixed";
    c.style.zIndex = "999999";
    c.style.left = "0";
    c.style.top = "0";
  }
});
await page.waitForTimeout(2000);
await page.screenshot({ path: "diag4-canvas-front.png" });

const cam = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const r = c && c.__r3f;
  const store = r && (r.store || r.root?.store || r.fiber?.store);
  const st = store && store.getState ? store.getState() : null;
  const cam = st?.camera;
  if (!cam) return "no camera access (" + (r ? "has __r3f" : "no __r3f") + ")";
  return {
    pos: [cam.position.x, cam.position.y, cam.position.z].map((n) => +n.toFixed(2)),
    rotY: +cam.rotation.y.toFixed(3),
  };
});
console.log("\n=== CAMERA AFTER JOIN ===\n" + JSON.stringify(cam));
const dbg = await page.evaluate(() => window.__dbg ?? "no __dbg");
console.log("\n=== __dbg (cam pos / player pos / alive / team / aim) ===\n" + JSON.stringify(dbg));

console.log("\n=== ASSET LOADS (models + animations) ===");
const entries = [...assetReqs.entries()].map(([u, s]) => `${s.padEnd(10)} ${u.replace("https://valor-akhil-1v1.surge.sh", "")}`);
console.log(entries.sort().join("\n") || "(no asset requests seen!)");
const stuck = entries.filter((e) => e.startsWith("PENDING") || /HTTP [45]/.test(e));
console.log("\nPROBLEM ASSETS:", stuck.length ? "\n" + stuck.join("\n") : "none — all 200");

// Inspect live game state via the dev hook
const state = await page.evaluate(() => {
  const v = window.__valor;
  const canvas = document.querySelector("canvas");
  let gl = "no-canvas";
  if (canvas) {
    const c = canvas.getContext("webgl2") || canvas.getContext("webgl");
    gl = c ? (c.isContextLost() ? "CONTEXT-LOST" : "alive") : "no-gl";
  }
  return {
    hasValorHook: !!v,
    glState: gl,
    canvasSize: canvas ? `${canvas.width}x${canvas.height}` : "none",
    players: v?.players?.length ?? "n/a",
    localPlayer: v?.localPlayer
      ? { alive: v.localPlayer.alive, pos: v.localPlayer.position, name: v.localPlayer.name }
      : null,
    match: v?.match ? { state: v.match.state?.tag, round: v.match.round } : "undefined",
  };
});

console.log("\n=== GAME STATE ===");
console.log(JSON.stringify(state, null, 2));
console.log("\n=== CONSOLE ERRORS / WARNINGS (deduped) ===");
console.log([...new Set(log)].join("\n") || "(none)");

await browser.close();
