"use strict";
/* 최종 검증 v2: 기기 감지 + 발사 파이프라인
   - headless Chrome은 진짜 사용자 제스처 없이 CDP 클릭으로 포인터 락을 못 걸므로,
     JS dispatchEvent mousedown(=기존 검증에서 실제로 락을 거는 방법)으로 락을 먼저 건다. */
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const PORT = 4444;
const BASE = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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
  if (!(await waitUp(10000))) { console.log("SERVER FAIL"); server.kill(); process.exit(1); }
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server", "--enable-webgl", "--use-gl=swiftshader"],
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__s === "function");
  await page.waitForSelector("#nickname");
  await page.$eval("#nickname", (el) => (el.value = "검증"));
  await page.click("#btn-create");
  await page.waitForSelector("#btn-start:not(.hidden)");
  await page.click("#btn-start");
  await page.waitForSelector("#hud:not(.hidden)");
  await page.waitForFunction(() => window.__s().phase === "combat", { timeout: 30000 });

  // 1) 기기 감지
  const dev = await page.evaluate(() => ({
    maxTP: navigator.maxTouchPoints,
    coarse: !!(window.matchMedia && matchMedia("(pointer: coarse)").matches),
    touchControlsHidden: document.getElementById("touch-controls").classList.contains("hidden"),
  }));
  console.log("[DEVICE]", JSON.stringify(dev));
  console.log("[DEVICE OK]", dev.maxTP > 0 && !dev.coarse && dev.touchControlsHidden);

  const myAmmo = () => page.evaluate(() => window.__s().myAmmo);
  const dispatch = (type) => page.evaluate((t) => {
    const cv = document.querySelector("#game-canvas canvas");
    cv.dispatchEvent(new MouseEvent(t, { button: 0, detail: 1, bubbles: true }));
  }, type);

  // 0) headless 포인터 락 안정화 대기
  await new Promise((r) => setTimeout(r, 1200));

  // 2) '첫 클릭(락 획득) + 홀드' → 즉시 발사
  //    mousedown은 락을 걸고(그대로 누른 채), 락 획득 시 pointerlockchange가 heldFire→firing 처리
  const ammo0 = await myAmmo();
  await dispatch("mousedown"); // heldFire=true + tryLock (락 획득됨)
  await new Promise((r) => setTimeout(r, 1200)); // 누른 채 유지
  await dispatch("mouseup");
  const ammo1 = await myAmmo();
  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  console.log("[FIRE-ON-LOCK] locked=", locked, "ammo", ammo0, "->", ammo1, "delta", ammo0 - ammo1, ammo0 - ammo1 > 0 ? "OK" : "FAIL");

  await new Promise((r) => setTimeout(r, 400));

  // 3) 짧은 탭(~30ms, 락 유지 상태) → 정확히 1발
  const ammo2 = await myAmmo();
  await dispatch("mousedown");
  await new Promise((r) => setTimeout(r, 30));
  await dispatch("mouseup");
  await new Promise((r) => setTimeout(r, 600));
  const ammo3 = await myAmmo();
  console.log("[TAP-1SHOT] ammo", ammo2, "->", ammo3, "delta", ammo2 - ammo3, ammo2 - ammo3 === 1 ? "OK" : "FAIL");

  // 4) 반자동(권총) 홀드 1초 → 기계연사 금지 (정확히 1발)
  const ammo4 = await myAmmo();
  await dispatch("mousedown");
  await new Promise((r) => setTimeout(r, 1000));
  await dispatch("mouseup");
  await new Promise((r) => setTimeout(r, 600));
  const ammo5 = await myAmmo();
  console.log("[SEMI-HOLD] ammo", ammo4, "->", ammo5, "delta", ammo4 - ammo5, ammo4 - ammo5 === 1 ? "OK" : "FAIL");

  // 5) 상태 보고
  console.log("[STATE]", await page.evaluate(() => JSON.stringify({ phase: window.__s().phase, weapon: window.__s().myWeapon, alive: window.__s().alive, firing: window.__s().firing })));

  await page.screenshot({ path: "scripts/verify-fire.png" });
  await browser.close();
  server.kill();
  process.exit(0);
})().catch(async (e) => { console.error("FATAL", e.stack || e.message); server.kill(); process.exit(1); });