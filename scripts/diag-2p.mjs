import { chromium } from "playwright";

const URL = "https://valor-akhil-1v1.surge.sh/#multiplayer";

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--enable-unsafe-swiftshader",
  ],
});

async function joinAs(name) {
  const ctx = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.fill('input[placeholder="Your name"]', name, { timeout: 8000 });
  await page.waitForSelector('button:has-text("Join")', { timeout: 10000 });
  await page.click('button:has-text("Join")', { timeout: 8000 });
  return page;
}

console.log("→ player 1 joining…");
const p1 = await joinAs("AlphaPW");
await p1.waitForTimeout(2000);
console.log("→ player 2 joining…");
const p2 = await joinAs("BetaPW");

// Let both settle + sync.
await p1.waitForTimeout(9000);

// Bring p1's canvas in front of the overlay and screenshot — should show player 2
// standing ON the ground (not floating), normal size.
await p1.evaluate(() => {
  const c = document.querySelector("canvas");
  if (c) { c.style.position = "fixed"; c.style.zIndex = "999999"; c.style.inset = "0"; }
});
await p1.waitForTimeout(1500);
await p1.screenshot({ path: "diag-2p-view.png" });
console.log("→ saved diag-2p-view.png (player1's view of player2)");

await browser.close();
