"use strict";
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const PORT = 4493;
const BASE = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LOG = path.join(process.env.TEMP || ".", "opencode", "probe-spike.log");
const L = (m) => { console.log(m); fs.appendFileSync(LOG, m + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.writeFileSync(LOG, "=== probe-spike ===\n");
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
  await page.$eval("#nickname", (el) => (el.value = "spikeprobe"));
  await page.evaluate(() => document.querySelector("#btn-create").click());
  await page.waitForSelector("#btn-start:not(.hidden)", { timeout: 20000 });
  await page.evaluate(() => document.querySelector("#btn-start").click());
  await page.waitForFunction(() => window.__s().phase === "combat", { timeout: 40000 });
  await sleep(2000);

  const info = await page.evaluate(() => {
    const s = window.__s();
    let markers = 0, total = 0;
    for (const [, ent] of s.players) {
      total++;
      if (ent.spikeSpr && ent.spikeSpr.visible) markers++;
    }
    const el = document.querySelector("#spike-status");
    return {
      carrierId: s.spike.carrierId,
      hasCarrier: !!s.spike.carrierId,
      markers, total,
      hudHidden: el.classList.contains("hidden"),
      hudText: el.textContent,
      hudClass: el.className,
    };
  });
  L("info: " + JSON.stringify(info));

  const checks = [];
  checks.push(["carrier assigned", info.hasCarrier]);
  checks.push(["carrier head marker visible (exactly 1)", info.markers === 1]);
  checks.push(["HUD shows carrier", !info.hudHidden && info.hudText.includes("스파이크")]);

  // drop the spike via server (simulate) — just check HUD renders drop state after some time
  let pass = 0;
  for (const [n, ok] of checks) { L(`${ok ? "PASS" : "FAIL"} ${n}`); if (ok) pass++; }
  L(`RESULT ${pass}/${checks.length}`);
  await browser.close().catch(() => {});
  server.kill();
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { L("FATAL " + (e.stack || e.message)); process.exit(1); });
