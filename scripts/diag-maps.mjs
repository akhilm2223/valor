import { chromium } from "playwright";
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader"],
});

// ---- Single-player map ----
const sp = await browser.newPage({ viewport: { width: 1100, height: 700 } });
await sp.goto("http://localhost:5174/?game", { waitUntil: "networkidle" });
await sp.waitForTimeout(6000);
await sp.screenshot({ path: "map-sp.png" });
console.log("captured SP");

// ---- Multiplayer map (deployed) ----
const mp = await browser.newPage({ viewport: { width: 1100, height: 700 } });
await mp.goto("https://valor-akhil-1v1.surge.sh/#multiplayer", { waitUntil: "networkidle" });
await mp.waitForTimeout(4000);
await mp.screenshot({ path: "map-mp-prejoin.png" });
await mp.fill('input[type="text"]', "MapTest").catch(() => {});
await mp.click('button[type="submit"]').catch(() => {});
await mp.waitForTimeout(6000);
await mp.screenshot({ path: "map-mp-joined.png" });
console.log("captured MP");

await browser.close();
