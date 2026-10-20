"use strict";
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const PORT = 4492;
const BASE = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LOG = path.join(process.env.TEMP || ".", "opencode", "probe-botmove.log");
const L = (m) => { console.log(m); fs.appendFileSync(LOG, m + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.writeFileSync(LOG, "=== probe-botmove ===\n");
  const server = spawn(process.execPath, ["server/server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  await sleep(2500);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-webgl", "--use-gl=swiftshader"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => L("[pageerror] " + e.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__s === "function", { timeout: 20000 });
  await page.$eval("#nickname", (el) => (el.value = "botmove"));
  await page.click("#btn-create");
  await page.waitForSelector("#btn-start:not(.hidden)", { timeout: 20000 });
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__s().phase === "combat", { timeout: 40000 });

  // sample bot positions over 12 seconds
  const samples = await page.evaluate(() => new Promise((resolve) => {
    const snap = () => {
      const arr = [];
      for (const [id, ent] of window.__s().players) {
        arr.push({ id, x: ent.target.x, z: ent.target.z });
      }
      return arr;
    };
    const out = [];
    let n = 0;
    const iv = setInterval(() => {
      out.push({ t: Date.now(), pos: snap() });
      if (++n >= 24) { clearInterval(iv); resolve(out); }
    }, 500);
  }));

  // compute per-bot total movement
  const move = new Map();
  for (let i = 1; i < samples.length; i++) {
    for (const p of samples[i].pos) {
      const prev = samples[i - 1].pos.find(q => q.id === p.id);
      if (!prev) continue;
      const d = Math.hypot(p.x - prev.x, p.z - prev.z);
      move.set(p.id, (move.get(p.id) || 0) + d);
    }
  }
  L(`sampled ${samples.length} ticks x ${samples[0].pos.length} remote players`);
  let stuck = 0, moved = 0;
  for (const [id, total] of [...move.entries()].sort((a, b) => a[1] - b[1])) {
    const tag = total < 3 ? "STUCK" : "moved";
    if (total < 3) stuck++; else moved++;
    L(`bot ${id}: total_move=${total.toFixed(1)}m ${tag}`);
  }
  L(`moved=${moved} stuck=${stuck}`);
  const ok = stuck === 0 && moved > 0;
  L(ok ? "PASS all bots moving" : "FAIL some bots stuck");
  await browser.close().catch(() => {});
  server.kill();
  process.exit(ok ? 0 : 1);
})().catch((e) => { L("FATAL " + (e.stack || e.message)); process.exit(1); });
