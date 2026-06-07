import { chromium } from "playwright";
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const url = process.argv[2] || "https://valor-akhil-1v1.surge.sh/#multiplayer";
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
// Join if the form is present (MP)
const input = await page.$('input[type="text"]');
if (input) {
  await input.fill("Lit");
  await page.click('button[type="submit"]').catch(() => {});
  await page.waitForTimeout(6000);
}
// Screenshot ONLY the WebGL canvas (excludes the green camera overlay + modals)
const canvas = await page.$("canvas");
if (canvas) {
  await canvas.screenshot({ path: process.argv[3] || "canvas-mp.png" });
  console.log("canvas captured");
} else {
  console.log("no canvas");
}
await browser.close();
