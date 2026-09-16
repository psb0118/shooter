"use strict";
/* 검증 v3b (mini): 리로드 없이 1회 전투에서
   메뉴 오픈 → btn-resume(닫힘) → 재락 → 메뉴 오픈 → btn-leave(로비 복귀)
   (headless ESC 키 제약으로 exitPointerLock 사용 — 실제 브라우저 ESC와 동일 pointerlockchange 경로) */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PORT = 4446;
const BASE = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LOG = path.join(process.env.TEMP || ".", "opencode", "vs4.log");
fs.appendFileSync(LOG, `\n=== run ${new Date().toISOString()} ===\n`);
const L = (m) => { console.log(m); fs.appendFileSync(LOG, m + "\n"); };

const wt = setTimeout(() => { L("WATCHDOG-EXIT"); process.exit(2); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout:" + label)), ms)),
]);
async function lockCanvas(page, tries = 3) {
  for (let i = 0; i < tries; i++) {
    await page.evaluate(() => {
      const cv = document.querySelector("#game-canvas canvas");
      cv.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true }));
    }).catch(() => {});
    await sleep(500);
    const locked = await page.evaluate(() => document.pointerLockElement !== null).catch(() => false);
    if (locked) return true;
  }
  return false;
}

let server = spawn(process.execPath, ["server/server.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
function waitUp(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const res = await fetch(BASE);
        res.resume?.();
        if (res.ok) { clearInterval(iv); resolve(true); return; }
      } catch {}
      if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 200);
  });
}

(async () => {
  if (!(await race(waitUp(10000), 12000, "waitup"))) { L("SERVER FAIL"); process.exit(1); }
  L("server up");
  const browser = await race(puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server", "--enable-webgl", "--use-gl=swiftshader"],
    ignoreHTTPSErrors: true,
  }), 60000, "launch");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await race(page.goto(BASE, { waitUntil: "domcontentloaded" }), 20000, "goto");
  await race(page.waitForFunction(() => typeof window.__s === "function"), 20000, "s");
  await page.$eval("#nickname", (el) => (el.value = "미니검증"));
  await page.click("#btn-create");
  await race(page.waitForSelector("#btn-start:not(.hidden)"), 20000, "btn-start");
  await page.click("#btn-start");
  await race(page.waitForSelector("#hud:not(.hidden)"), 20000, "hud");
  await race(page.waitForFunction(() => window.__s().phase === "combat", { timeout: 30000 }), 35000, "combat");
  L("in combat");

  await sleep(1000);
  const l1 = await lockCanvas(page);
  await page.evaluate(() => {
    const cv = document.querySelector("#game-canvas canvas");
    cv.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail: 1, bubbles: true }));
  }).catch(() => {});
  L("[LOCK1] " + (l1 ? "OK" : "FAIL"));

  await page.evaluate(() => document.exitPointerLock()).catch(() => {});
  await sleep(400);
  const open1 = await race(page.evaluate(() => !document.getElementById("pause").classList.contains("hidden")), 6000, "open1").catch(() => "ERR");
  L("[OPEN1] " + open1);

  await race(page.click("#btn-resume"), 5000, "resume").catch((e) => L("  resume err " + e.message));
  await sleep(400);
  const closed = await page.evaluate(() => document.getElementById("pause").classList.contains("hidden")).catch(() => "ERR");
  const resumeOk = open1 === true && closed === true;
  L("[RESUME] open1=" + open1 + " closed=" + closed + (resumeOk ? " OK" : " FAIL"));

  await sleep(500);
  const l2 = await lockCanvas(page);
  await page.evaluate(() => {
    const cv = document.querySelector("#game-canvas canvas");
    cv.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail: 1, bubbles: true }));
  }).catch(() => {});
  L("[LOCK2] " + (l2 ? "OK" : "FAIL"));
  await page.evaluate(() => document.exitPointerLock()).catch(() => {});
  await sleep(400);
  const open2 = await race(page.evaluate(() => !document.getElementById("pause").classList.contains("hidden")), 6000, "open2").catch(() => "ERR");
  L("[OPEN2] " + open2);

  await race(page.click("#btn-leave"), 5000, "leave").catch((e) => L("  leave err " + e.message));
  await sleep(600);
  const lobbyBack = await page.evaluate(() => !document.getElementById("lobby").classList.contains("hidden") &&
    document.getElementById("pause").classList.contains("hidden")).catch(() => false);
  const leaveOk = open2 === true && lobbyBack === true;
  L("[LEAVE] open2=" + open2 + " lobbyBack=" + lobbyBack + (leaveOk ? " OK" : " FAIL"));

  L("[PAGE-ERRORS] " + pageErrors.length + " " + JSON.stringify(pageErrors.slice(0, 3)));
  await page.screenshot({ path: "scripts/verify-settings.png" }).catch(() => {});
  L("ALL DONE");
  await browser.close().catch(() => {});
  clearTimeout(wt);
  process.exit(0);
})().catch((e) => { L("FATAL " + (e.stack || e.message)); server.kill(); process.exit(1); });