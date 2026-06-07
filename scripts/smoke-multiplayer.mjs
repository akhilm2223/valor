// Cross-tab smoke test for the live SpacetimeDB-backed multiplayer demo.
//
// Boots three independent browser contexts (so each tab gets its own STDB
// identity token):
//   • Tab A — #multiplayer  (name: "Aidan")
//   • Tab B — #multiplayer  (name: "Akhil")
//   • Tab C — #spectator    (read-only sanity check)
//
// Drives the session through the dev-only `window.__valor` hook (set inside
// MultiplayerGame in DEV builds) and asserts the cross-tab loop:
//   join → move → fire → hit → kill → bark → spectator-stays-read-only.
// Probes the live STDB module via `spacetime sql` between assertions so we
// confirm server-authoritative truth, not client-side wishful thinking.
//
// Writes a markdown report to DEMO-VERIFICATION.md (gitignored — output
// artifact only) plus PNG screenshots to /tmp/valor-smoke-multi-{a,b,c}.png.
// Exits non-zero on any assertion failure, pageerror, or console error.
//
// Pre-reqs:
//   • Vite dev server at $SMOKE_BASE_URL (default http://localhost:5175).
//   • Local STDB instance with the `valor` module running.
//   • `spacetime` CLI on $PATH (we re-export the usual path before each call).
//
// Run:
//   node scripts/smoke-multiplayer.mjs
//   HEADED=1 node scripts/smoke-multiplayer.mjs   # show three real windows

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:5175";
const HEADED = !!process.env.HEADED;
const SHOT_A = "/tmp/valor-smoke-multi-a.png";
const SHOT_B = "/tmp/valor-smoke-multi-b.png";
const SHOT_C = "/tmp/valor-smoke-multi-c.png";
const REPORT = "DEMO-VERIFICATION.md";
const SHOT_DAMAGE = 34; // mirrors server/src/lib.rs:17
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:/opt/homebrew/opt/rustup/bin:$PATH"';

// ---- assertion + sql helpers --------------------------------------------

const assertions = []; // { step, ok, expected, observed, note }
const sqlSnapshots = []; // { step, query, rows }

function record(step, ok, expected, observed, note) {
  assertions.push({ step, ok: !!ok, expected, observed, note });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${step}` + (ok ? "" : ` — expected ${expected}, got ${observed}${note ? ` (${note})` : ""}`));
}

const STDB_TARGET = process.env.STDB_TARGET ?? "local";
const STDB_DB = process.env.STDB_DB ?? "valor";

function sql(query) {
  const out = execSync(`${PATH_PREFIX} && spacetime sql -s ${STDB_TARGET} ${STDB_DB} ${JSON.stringify(query)}`, {
    shell: "/bin/zsh",
    encoding: "utf8",
  });
  return out;
}

// Parse `spacetime sql` output. Format:
//   WARNING: ... \n  (sometimes)
//   col1 | col2 | col3
//  -----+-----+-----
//   v1  |  v2 |  v3
function parseSqlRows(out) {
  const lines = out.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("WARNING"));
  if (lines.length < 2) return [];
  const header = lines[0].split("|").map((c) => c.trim());
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim());
    if (cells.length !== header.length) continue;
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c];
    rows.push(row);
  }
  return rows;
}

function snapSql(step, query) {
  const out = sql(query);
  const rows = parseSqlRows(out);
  sqlSnapshots.push({ step, query, out: out.trim(), rows });
  return rows;
}

// Strip surrounding double-quotes that `spacetime sql` prints around strings.
function unq(s) {
  if (typeof s !== "string") return s;
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

// ---- pre-flight: tsc clean -----------------------------------------------

console.log("[1/15] pre-flight: npx tsc --noEmit");
try {
  execSync("npx tsc --noEmit", { stdio: "inherit", encoding: "utf8" });
  record("pre-flight tsc --noEmit", true, "exit 0", "exit 0");
} catch (e) {
  record("pre-flight tsc --noEmit", false, "exit 0", `exit ${e.status ?? "?"}`, "see tsc output above");
  process.exit(1);
}

// ---- launch chromium -----------------------------------------------------

console.log("[2/15] launching chromium");
const browser = await chromium.launch(
  HEADED
    ? { headless: false }
    : {
        args: [
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--ignore-gpu-blocklist",
          "--enable-webgl",
        ],
      },
);

// Independent storage per context → distinct STDB identity tokens per tab.
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const ctxC = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
const pageC = await ctxC.newPage();

// Per-tab error harnesses so the final report can attribute failures.
function harness(label, page) {
  const log = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on("pageerror", (e) => log.pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") log.consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) log.failedRequests.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => log.failedRequests.push(`FAILED ${r.url()}`));
  return { label, log };
}
const hA = harness("A", pageA);
const hB = harness("B", pageB);
const hC = harness("C", pageC);

// ---- helpers for the page-level dance ------------------------------------

async function waitForValor(page, predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(predicate);
    if (ok) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

async function joinTab(page, name) {
  await page.goto(`${BASE}/#multiplayer`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 15000 });
  // Pre-test STT/Web-Speech sniff (we only need this on tab A but it's cheap
  // to install everywhere — speechSynthesis exists in headless Chromium).
  await page.evaluate(() => {
    /** @type {string[]} */
    window.__sttCalls = [];
    try {
      const ss = window.speechSynthesis;
      if (ss && typeof ss.speak === "function") {
        const orig = ss.speak.bind(ss);
        ss.speak = (u) => {
          try { window.__sttCalls.push(u && u.text != null ? String(u.text) : "<empty>"); } catch {}
          try { orig(u); } catch {}
        };
      }
    } catch {}
  });
  // Fill the JoinForm name input + click Join. JoinForm uses an <input
  // type="text"> and the button text changes between "Waiting…" and "Join" —
  // poll on enabled state so we don't race the connection.
  await page.waitForSelector("input[type=text]", { timeout: 10000 });
  await page.fill("input[type=text]", name);
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[type="submit"]');
      return btn && !btn.disabled;
    },
    { timeout: 15000 },
  );
  await page.click('button[type="submit"]', { force: true });
  // Wait for the dev hook to expose a live alive local player.
  const ok = await waitForValor(
    page,
    () => !!(window.__valor && window.__valor.localPlayer && window.__valor.localPlayer.alive),
    10000,
  );
  return ok;
}

// ---- step 3-4: boot tabs A + B ------------------------------------------

console.log("[3/15] tab A: goto + join as Aidan");
const joinedA = await joinTab(pageA, "Aidan");
record("tab A join", joinedA, "window.__valor.localPlayer.alive true within 10s", String(joinedA));

console.log("[4/15] tab B: goto + join as Akhil");
const joinedB = await joinTab(pageB, "Akhil");
record("tab B join", joinedB, "window.__valor.localPlayer.alive true within 10s", String(joinedB));

// Pageerror gate after the join handshake — the join modal click is the
// likely failure surface and we want to know early.
record("tab A no pageerror after join", hA.log.pageErrors.length === 0, "0", String(hA.log.pageErrors.length));
record("tab B no pageerror after join", hB.log.pageErrors.length === 0, "0", String(hB.log.pageErrors.length));

// ---- step 5: SQL probe — initial state ----------------------------------

console.log("[5/15] SQL probe — initial players state");
let pRows = snapSql("initial-players", "SELECT id, name, team, alive FROM players");
// Reduce to just our two named players (the table may carry leftovers from
// earlier sessions; we only care that Aidan + Akhil are present + balanced).
const aRow = pRows.find((r) => unq(r.name) === "Aidan");
const bRow = pRows.find((r) => unq(r.name) === "Akhil");
record("players row for Aidan", !!aRow, "present", aRow ? "present" : "missing");
record("players row for Akhil", !!bRow, "present", bRow ? "present" : "missing");
if (aRow && bRow) {
  const teams = new Set([aRow.team, bRow.team]);
  record(
    "Aidan + Akhil on opposite teams",
    teams.size === 2 && teams.has("0") && teams.has("1"),
    "{0,1}",
    `{${aRow.team},${bRow.team}}`,
  );
  record(
    "Aidan + Akhil both alive on spawn",
    aRow.alive === "true" && bRow.alive === "true",
    "true,true",
    `${aRow.alive},${bRow.alive}`,
  );
}

// We also need the integer player ids to correlate later shots rows.
const aidanId = aRow ? Number(aRow.id) : null;
const akhilId = bRow ? Number(bRow.id) : null;

// ---- step 6: move test (tab A holds W) ----------------------------------

console.log("[6/15] move test — tab A holds W for 800ms");
// Read pre-move z from tab A's live dev hook. SpacetimeDB SQL can't project
// composite-typed columns directly, so we use the client-side view (which
// reflects the same authoritative `players` row Maincloud just pushed us).
const aBeforeZ = await pageA.evaluate(() => window.__valor?.localPlayer?.position?.z ?? null);

await pageA.bringToFront();
// Focus the canvas so keydown actually feeds useKeys (which listens on
// window, but a focused canvas is closer to a real user).
await pageA.focus("canvas").catch(() => {});
await pageA.keyboard.down("KeyW");
await pageA.waitForTimeout(800);
await pageA.keyboard.up("KeyW");
await pageA.waitForTimeout(300); // server tick catch-up

const aAfterZ = await pageA.evaluate(() => window.__valor?.localPlayer?.position?.z ?? null);
const dz = aBeforeZ != null && aAfterZ != null ? aBeforeZ - aAfterZ : null;
// We expect z to decrease (forward is -z by the camera basis). Conservative
// lower bound: 1.5 m. Theoretical max = MOVE_SPEED (3.6) * 0.8s ≈ 2.88m.
record(
  "tab A moved forward via WASD (z decreased ≥ 1.5m)",
  dz != null && dz >= 1.5,
  ">=1.5",
  dz != null ? dz.toFixed(3) : "null",
  `before=${aBeforeZ}, after=${aAfterZ}`,
);

// ---- step 7: fire test (tab A aims at tab B, single shot) ---------------

console.log("[7/15] fire test — tab A shoots at tab B");
// Get tab B's current position from tab A's live `players` view.
const akhilPos = await pageA.evaluate(() => {
  const p = window.__valor.players.find((x) => x.name === "Akhil");
  return p ? { x: p.position.x, y: p.position.y, z: p.position.z, id: p.id } : null;
});
const aidanPos = await pageA.evaluate(() => {
  const p = window.__valor.localPlayer;
  return p ? { x: p.position.x, y: p.position.y, z: p.position.z, id: p.id } : null;
});
if (!akhilPos || !aidanPos) {
  record("tab A can read Akhil position", false, "object", String(akhilPos));
} else {
  record("tab A can read both positions", true, "objects", "objects");
}

let preShotCount = snapSql("pre-fire-shots-count", "SELECT id FROM shots").length;
let akhilPreHealth = null;
{
  const r = snapSql("pre-fire-akhil-health", `SELECT id, name, health FROM players`).find((x) => unq(x.name) === "Akhil");
  akhilPreHealth = r ? Number(r.health) : null;
}

if (akhilPos && aidanPos) {
  const dx = akhilPos.x - aidanPos.x;
  const dy = akhilPos.y - aidanPos.y;
  const dz2 = akhilPos.z - aidanPos.z;
  const mag = Math.max(1e-4, Math.hypot(dx, dy, dz2));
  const aim = { x: dx / mag, y: dy / mag, z: dz2 / mag };
  await pageA.evaluate(({ aim }) => {
    const v = window.__valor;
    v.driver.updateInput(
      { aim, lean: { x: 0, z: 0 }, crouch: false, firePressed: true, reload: false },
      v.localPlayer,
    );
  }, { aim });
  await pageA.waitForTimeout(400);
}

let shotsRows = snapSql("post-fire-shots", "SELECT id, shooter_id, hit, victim_id, damage FROM shots");
const postShotCount = shotsRows.length;
record("shots table grew by ≥1", postShotCount > preShotCount, `>${preShotCount}`, String(postShotCount));
// Latest row — shots are append-only with a monotonically increasing id, so
// the row with the max id is the one we just fired.
let latest = null;
for (const r of shotsRows) {
  const id = Number(r.id);
  if (!latest || id > Number(latest.id)) latest = r;
}
if (latest) {
  record(
    "latest shot shooter is Aidan",
    aidanId != null && Number(latest.shooter_id) === aidanId,
    `shooter_id=${aidanId}`,
    `shooter_id=${latest.shooter_id}`,
  );
  record(
    "latest shot hit=true",
    latest.hit === "true",
    "true",
    String(latest.hit),
  );
  record(
    "latest shot victim is Akhil",
    akhilId != null && latest.victim_id !== "(none)" && Number(latest.victim_id) === akhilId,
    `victim_id=${akhilId}`,
    `victim_id=${latest.victim_id}`,
  );
}

// Akhil's health must drop by SHOT_DAMAGE (34).
let akhilHealthRows = snapSql("post-fire-akhil-health", `SELECT id, name, health FROM players`);
const akhilPostRow = akhilHealthRows.find((r) => unq(r.name) === "Akhil");
const akhilPostHealth = akhilPostRow ? Number(akhilPostRow.health) : null;
record(
  "Akhil health dropped by exactly SHOT_DAMAGE",
  akhilPreHealth != null && akhilPostHealth != null && akhilPreHealth - akhilPostHealth === SHOT_DAMAGE,
  `${akhilPreHealth} - ${SHOT_DAMAGE}`,
  `${akhilPreHealth} → ${akhilPostHealth}`,
);

// ---- step 8: kill loop — two more shots to finish Akhil -----------------

console.log("[8/15] kill loop — two more shots");
// Refresh aim each shot in case Akhil drifted (he shouldn't have, but cheap).
for (let i = 0; i < 2; i++) {
  const aim = await pageA.evaluate(() => {
    const v = window.__valor;
    const me = v.localPlayer;
    const tgt = v.players.find((p) => p.name === "Akhil");
    if (!me || !tgt) return null;
    const dx = tgt.position.x - me.position.x;
    const dy = tgt.position.y - me.position.y;
    const dz = tgt.position.z - me.position.z;
    const m = Math.max(1e-4, Math.hypot(dx, dy, dz));
    return { x: dx / m, y: dy / m, z: dz / m };
  });
  if (!aim) break;
  await pageA.evaluate(({ aim }) => {
    const v = window.__valor;
    v.driver.updateInput(
      { aim, lean: { x: 0, z: 0 }, crouch: false, firePressed: true, reload: false },
      v.localPlayer,
    );
  }, { aim });
  await pageA.waitForTimeout(400);
}

let killRows = snapSql("post-kill-akhil-state", `SELECT id, name, health, alive FROM players`);
const akhilKillRow = killRows.find((r) => unq(r.name) === "Akhil");
record(
  "Akhil alive=false after 3 hits",
  !!akhilKillRow && akhilKillRow.alive === "false",
  "false",
  akhilKillRow ? akhilKillRow.alive : "missing",
);

// Commentary must have a Bark mentioning both names.
let commRows = snapSql("post-kill-commentary", `SELECT id, kind, text FROM commentary`);
let latestBark = null;
for (const r of commRows) {
  const id = Number(r.id);
  if (r.kind === "Bark" && (!latestBark || id > Number(latestBark.id))) latestBark = r;
}
const barkText = latestBark ? unq(latestBark.text) : "";
record(
  "latest Bark mentions both Aidan and Akhil",
  !!latestBark && barkText.includes("Aidan") && barkText.includes("Akhil"),
  "Bark containing 'Aidan' + 'Akhil'",
  latestBark ? `${latestBark.kind}: ${barkText}` : "no Bark",
);

// ---- step 9-11: spectator tab — must not write --------------------------

console.log("[9/15] snapshot commentary + shots row counts before tab C");
const preSpecComm = snapSql("pre-spectator-commentary-count", "SELECT id FROM commentary").length;
const preSpecShots = snapSql("pre-spectator-shots-count", "SELECT id FROM shots").length;

console.log("[10/15] tab C: goto #spectator + hold 1s");
await pageC.goto(`${BASE}/#spectator`, { waitUntil: "domcontentloaded" });
await pageC.waitForSelector("canvas", { timeout: 15000 });
await pageC.waitForTimeout(1500);

const postSpecComm = snapSql("post-spectator-commentary-count", "SELECT id FROM commentary").length;
const postSpecShots = snapSql("post-spectator-shots-count", "SELECT id FROM shots").length;
record(
  "spectator did not write to commentary",
  postSpecComm === preSpecComm,
  `${preSpecComm}`,
  `${postSpecComm}`,
);
record(
  "spectator did not write to shots",
  postSpecShots === preSpecShots,
  `${preSpecShots}`,
  `${postSpecShots}`,
);
record("tab C no pageerror", hC.log.pageErrors.length === 0, "0", String(hC.log.pageErrors.length));

// ---- step 12: bark playback assertion (tab A) ---------------------------

console.log("[11/15] bark playback — speechSynthesis call count on tab A");
const sttCalls = await pageA.evaluate(() => (window.__sttCalls || []).slice());
record(
  "speechSynthesis.speak called ≥1 on tab A",
  Array.isArray(sttCalls) && sttCalls.length >= 1,
  ">=1",
  String(sttCalls?.length ?? 0),
  sttCalls?.length ? `first=${JSON.stringify(sttCalls[0])}` : undefined,
);

// ---- step 13: screenshots -----------------------------------------------

console.log("[12/15] screenshots");
try {
  await pageA.screenshot({ path: SHOT_A });
  await pageB.screenshot({ path: SHOT_B });
  await pageC.screenshot({ path: SHOT_C });
  record("screenshots written", true, "3 PNGs", `${SHOT_A}, ${SHOT_B}, ${SHOT_C}`);
} catch (e) {
  record("screenshots written", false, "3 PNGs", String(e));
}

// ---- final tab pageerror sweep ------------------------------------------

record(
  "tab A no console errors",
  hA.log.consoleErrors.length === 0,
  "0",
  String(hA.log.consoleErrors.length),
);
record(
  "tab B no console errors",
  hB.log.consoleErrors.length === 0,
  "0",
  String(hB.log.consoleErrors.length),
);
record(
  "tab C no console errors",
  hC.log.consoleErrors.length === 0,
  "0",
  String(hC.log.consoleErrors.length),
);

// ---- close browser -------------------------------------------------------

console.log("[13/15] closing browser");
await browser.close();

// ---- write the markdown report ------------------------------------------

console.log("[14/15] writing report → DEMO-VERIFICATION.md");
const allGreen = assertions.every((a) => a.ok);
const ts = new Date().toISOString();

function dedupe(list) {
  return [...new Set(list)];
}

let md = "";
md += `# Valor Demo Verification — Phase 6 Smoke Run\n\n`;
md += `- **Timestamp:** ${ts}\n`;
md += `- **Base URL:** ${BASE}\n`;
md += `- **Mode:** ${HEADED ? "headed" : "headless (SwiftShader)"}\n`;
md += `- **Verdict:** ${allGreen ? "READY FOR DEMO" : "NOT READY — see triage below"}\n\n`;

md += `## Assertions\n\n`;
md += `| # | Step | Result | Expected | Observed | Note |\n`;
md += `|---|---|---|---|---|---|\n`;
assertions.forEach((a, i) => {
  const mark = a.ok ? "PASS" : "FAIL";
  const exp = String(a.expected ?? "").replace(/\|/g, "\\|");
  const obs = String(a.observed ?? "").replace(/\|/g, "\\|");
  const note = String(a.note ?? "").replace(/\|/g, "\\|");
  md += `| ${i + 1} | ${a.step} | ${mark} | ${exp} | ${obs} | ${note} |\n`;
});

md += `\n## Per-tab error logs (deduped)\n\n`;
for (const h of [hA, hB, hC]) {
  md += `### Tab ${h.label}\n`;
  md += `- pageErrors: ${dedupe(h.log.pageErrors).length === 0 ? "none" : ""}\n`;
  for (const e of dedupe(h.log.pageErrors)) md += `  - \`${e}\`\n`;
  md += `- consoleErrors: ${dedupe(h.log.consoleErrors).length === 0 ? "none" : ""}\n`;
  for (const e of dedupe(h.log.consoleErrors)) md += `  - \`${e}\`\n`;
  md += `- failedRequests: ${dedupe(h.log.failedRequests).length === 0 ? "none" : ""}\n`;
  for (const e of dedupe(h.log.failedRequests)) md += `  - \`${e}\`\n`;
  md += `\n`;
}

md += `## SQL snapshots\n\n`;
for (const s of sqlSnapshots) {
  md += `### ${s.step}\n`;
  md += "```sql\n" + s.query + "\n```\n";
  md += "```\n" + s.out + "\n```\n\n";
}

md += `## Triage\n\n`;
const fails = assertions.filter((a) => !a.ok);
if (fails.length === 0) {
  md += `_None — all assertions passed._\n`;
} else {
  for (const f of fails) {
    md += `- **${f.step}** — expected \`${f.expected}\`, observed \`${f.observed}\`${f.note ? `; ${f.note}` : ""}\n`;
  }
}

md += `\n## Screenshots\n`;
md += `- Tab A: ${SHOT_A}\n- Tab B: ${SHOT_B}\n- Tab C: ${SHOT_C}\n`;

writeFileSync(REPORT, md);

// ---- exit ----------------------------------------------------------------

console.log("[15/15] done");
console.log(`report: ${REPORT}`);
console.log(`verdict: ${allGreen ? "READY FOR DEMO" : "NOT READY"}`);

const fatalErr =
  hA.log.pageErrors.length > 0 ||
  hB.log.pageErrors.length > 0 ||
  hC.log.pageErrors.length > 0 ||
  hA.log.consoleErrors.length > 0 ||
  hB.log.consoleErrors.length > 0 ||
  hC.log.consoleErrors.length > 0;
process.exit(allGreen && !fatalErr ? 0 : 1);
