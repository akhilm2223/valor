import { chromium } from "playwright";

const URL = "https://valor-akhil-1v1.surge.sh/#multiplayer";
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForTimeout(5000);
await page.fill('input[placeholder="Your name"]', "MoveTest", { timeout: 8000 });
await page.waitForSelector('button:has-text("Join")', { timeout: 10000 });
await page.click('button:has-text("Join")', { timeout: 8000 });
await page.waitForTimeout(5000);

const read = () => page.evaluate(() => window.__dbg ?? "no __dbg");
console.log("before:", JSON.stringify(await read()));

// Press W (forward) via the keyboard fallback for 3s.
await page.evaluate(() => document.querySelector("canvas")?.focus());
await page.keyboard.down("KeyW");
console.log("...holding W for 3s...");
await page.waitForTimeout(1500);
console.log("during:", JSON.stringify(await read()));
await page.waitForTimeout(1500);
await page.keyboard.up("KeyW");
await page.waitForTimeout(1500);
console.log("after: ", JSON.stringify(await read()));

await browser.close();
