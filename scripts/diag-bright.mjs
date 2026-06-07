import { chromium } from "playwright";
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader"],
});
const mp = await browser.newPage({ viewport: { width: 1100, height: 700 } });
await mp.goto("https://valor-akhil-1v1.surge.sh/#multiplayer", { waitUntil: "domcontentloaded" });
await mp.waitForTimeout(6000);
await mp.screenshot({ path: "map-mp2-prejoin.png" });
console.log("prejoin captured");
await browser.close();
