import { chromium } from "playwright";

const URL = process.argv[2] || "https://valor-akhil-1v1.surge.sh/#multiplayer";
const TAG = process.argv[3] || "deployed";

// Real headed Chrome (real GPU — reproduces Edge's integrated-GPU behaviour that
// headless swiftshader hides). Persistent profile in .playwright-mcp.
const ctx = await chromium.launchPersistentContext(".playwright-mcp", {
  channel: "chrome",
  headless: false,
  viewport: null,
  permissions: ["camera", "microphone"],
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

// Catch WebGL context loss as early as possible.
await ctx.addInitScript(() => {
  window.__ctx = { lost: false, restored: false, errors: [] };
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const c = origGet.apply(this, args);
    if (args[0] && String(args[0]).includes("webgl")) {
      this.addEventListener("webglcontextlost", () => (window.__ctx.lost = true));
      this.addEventListener("webglcontextrestored", () => (window.__ctx.restored = true));
    }
    return c;
  };
  window.addEventListener("error", (e) => window.__ctx.errors.push(String(e.message).slice(0, 200)));
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("console", (m) => {
  const t = m.text();
  if (/context lost|webgl|error/i.test(t)) console.log(`[console] ${t.slice(0, 160)}`);
});

console.log("→ GPU:", "opening real Chrome…");
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(5000);

// Join
try {
  await page.fill('input[placeholder="Your name"]', "ChromeTest", { timeout: 8000 });
  await page.waitForSelector('button:has-text("Join")', { timeout: 10000 });
  await page.click('button:has-text("Join")', { timeout: 8000 });
  console.log("→ joined");
} catch (e) {
  console.log("join error:", e.message.slice(0, 120));
}

// Monitor: context loss + GL renderer + screenshots. Bring the canvas in FRONT
// of the calibration overlay so the screenshot shows the actual 3D render.
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(4000);
  const s = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (c) { c.style.position = "fixed"; c.style.zIndex = "999999"; c.style.inset = "0"; }
    const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return {
      ctxLost: window.__ctx?.lost,
      ctxRestored: window.__ctx?.restored,
      glLostNow: gl ? gl.isContextLost() : "no-gl",
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?",
      errors: window.__ctx?.errors?.slice(0, 3),
    };
  });
  console.log(`[${TAG}] t+${(i + 1) * 4}s`, JSON.stringify(s));
  await page.screenshot({ path: `chrome-${TAG}-t${(i + 1) * 4}.png` });
}

console.log("→ done (leaving Chrome open 20s so you can watch)…");
await page.waitForTimeout(20000);
await ctx.close();
