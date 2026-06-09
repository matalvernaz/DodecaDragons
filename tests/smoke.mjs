// Headless smoke + performance probe for DodecaDragons.
//
// Loads the real page in Chromium, fails on any uncaught console/page error,
// asserts the game initializes and ticks, asserts the expansion + omniverse
// layers wired up, and samples requestAnimationFrame frame intervals so the
// known render() lag is quantified in CI rather than guessed.

import { chromium } from "playwright";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join, normalize } from "path";

const ROOT = process.cwd();
const PORT = 8123;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp3": "audio/mpeg", ".json": "application/json", ".txt": "text/plain"
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const full = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const data = await readFile(full);
    res.writeHead(200, { "content-type": TYPES[extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

let failed = false;
const fail = (msg) => { console.error("FAIL: " + msg); failed = true; };

try {
  await page.goto("http://localhost:" + PORT + "/", { waitUntil: "networkidle", timeout: 30000 });

  // Game finished loading when the loading cover is hidden.
  await page.waitForFunction(() => {
    const c = document.getElementById("loadingScreenCover");
    return c && getComputedStyle(c).display === "none";
  }, { timeout: 15000 }).catch(() => fail("loading screen never cleared"));

  const checks = await page.evaluate(() => ({
    hasGame: typeof window.game === "object" && window.game !== null,
    goldDefined: !!(window.game && window.game.gold !== undefined),
    launcher: !!document.getElementById("expLauncher"),
    omniApply: typeof window.omniApply === "function",
    applyOffline: typeof window.applyOfflineProgress === "function",
    omniverseState: !!(window.game && window.game.omniverse)
  }));
  console.log("checks:", JSON.stringify(checks));
  if (!checks.hasGame || !checks.goldDefined) fail("game did not initialize");
  if (!checks.launcher) fail("expansion launcher (#expLauncher) missing");
  if (!checks.omniApply || !checks.applyOffline) fail("expansion/omniverse globals missing");
  if (!checks.omniverseState) fail("game.omniverse not created by ensureDefaults");

  // Tick must advance lastUpdate without throwing.
  const t1 = await page.evaluate(() => (window.game && window.game.lastUpdate) || 0);
  await page.waitForTimeout(1500);
  const t2 = await page.evaluate(() => (window.game && window.game.lastUpdate) || 0);
  console.log("lastUpdate advanced:", t2 > t1);
  if (!(t2 > t1)) fail("update tick did not advance lastUpdate");

  // Performance probe: sample frame intervals over ~120 frames.
  const perf = await page.evaluate(() => new Promise((resolve) => {
    const deltas = []; let last = performance.now(); let n = 0;
    function tick() {
      const now = performance.now();
      deltas.push(now - last); last = now; n++;
      if (n < 120) requestAnimationFrame(tick);
      else {
        const sorted = deltas.slice().sort((a, b) => a - b);
        const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        resolve({
          avgMs: +avg.toFixed(2),
          p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
          worstMs: +sorted[sorted.length - 1].toFixed(2),
          longFrames: deltas.filter((d) => d > 50).length
        });
      }
    }
    requestAnimationFrame(tick);
  }));
  console.log("perf (frame intervals):", JSON.stringify(perf));

  // The real lag proxy: synchronous cost of render() with every box active
  // (a fresh idle game barely exercises it). This is what the render work targets.
  const renderCost = await page.evaluate(() => {
    if (typeof render !== "function" || typeof game === "undefined" || !game) return null;
    const saved = game.unlocks;
    game.unlocks = 36; // unlock all layers so render() positions all 47 boxes
    const N = 200, cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) render(cx + (i % 40) - 20, cy + (i % 30) - 15);
    const t1 = performance.now();
    game.unlocks = saved;
    return { calls: N, totalMs: +(t1 - t0).toFixed(2), perCallMs: +((t1 - t0) / N).toFixed(3) };
  });
  console.log("render() cost @ full unlocks:", JSON.stringify(renderCost));
  // Reported, not gated — tracks the render path's synchronous cost over time.

  if (errors.length) { errors.forEach((e) => console.error("  " + e)); fail(errors.length + " console/page error(s)"); }
} catch (e) {
  fail("smoke threw: " + e.message);
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? "SMOKE: FAILED" : "SMOKE: PASSED");
process.exit(failed ? 1 : 0);
