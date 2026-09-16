"use strict";
/* 재현: 포인터 락 → 발사 파이프라인 검증 */
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");

const PORT = 3333;
const BASE = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let server = spawn(process.execPath, ["server/server-instr.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
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

function stDump() {
  const s = window.__s();
  return JSON.stringify({
    inGame: s.inGame, phase: s.phase, round: s.round, alive: s.alive,
    myWeapon: s.myWeapon, myAmmo: s.myAmmo, myReloading: s.myReloading,
    firing: s.firing, ads: s.ads, uiLock: s.uiLock, buyOpen: !document.getElementById("weapon-select").classList.contains("hidden"),
    pointerLocked: document.pointerLockElement !== null,
    yaw: +s.yaw.toFixed(2), x: +s.x.toFixed(2), z: +s.z.toFixed(2),
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
  page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

  await page.goto(BASE, { timeout: 30000, waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__s === "function");
  await page.waitForSelector("#nickname");
  await page.$eval("#nickname", (el) => (el.value = "테스트"));
  await page.click("#btn-create");
  await page.waitForSelector("#btn-start:not(.hidden)");
  await page.click("#btn-start");
  await page.waitForSelector("#hud:not(.hidden)");
  console.log("[GAME STARTED]");

  // combat 진입까지 대기
  await page.waitForFunction(() => window.__s().phase === "combat", { timeout: 25000 });
  console.log("[COMBAT] phase=combat");

  // 포인터 락 시도: 캔버스 클릭
  await page.waitForFunction(() => !document.getElementById("weapon-select").classList.contains("hidden") === false, { timeout: 5000 }).catch(()=>{});
  await page.evaluate(() => { const s = window.__s(); s.uiLock = false; document.getElementById("weapon-select").classList.add("hidden"); });
  const lockedAfterClick = await page.evaluate(() => {
    const cv = document.querySelector("#game-canvas canvas");
    cv.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true }));
    return new Promise((res) => setTimeout(() => res(!!document.pointerLockElement), 300));
  });
  console.log("[LOCK] pointerLockElement after mousedown =", lockedAfterClick);

  const ammo0 = await page.evaluate(() => window.__s().myAmmo);
  console.log("[AMMO0]", ammo0);

  // 발사 파이프라인: state.firing=true 로 직접 테스트 (포인터 락과 무관)
  await page.evaluate(() => { const s = window.__s(); s.firing = true; });
  await new Promise((r) => setTimeout(r, 2000));
  const ammo1 = await page.evaluate(() => window.__s().myAmmo);
  await page.evaluate(() => { window.__s().firing = false; });
  console.log("[AMMO1]", ammo1, "delta", ammo0 - ammo1);
  console.log("[ST]", await page.evaluate(stDump));

  // 마우스로 실제 발사 시도 (포인터 락 상태라면)
  if (lockedAfterClick) {
    const ammo2 = await page.evaluate(() => window.__s().myAmmo);
    await page.mouse.down({ button: "left" });
    await new Promise((r) => setTimeout(r, 1500));
    await page.mouse.up({ button: "left" });
    const ammo3 = await page.evaluate(() => window.__s().myAmmo);
    console.log("[MOUSE FIRE] ammo", ammo2, "->", ammo3, "delta", ammo2 - ammo3);
  }

  await page.screenshot({ path: "scripts/repro-fire.png" });
  await browser.close();
  server.kill();
  process.exit(0);
})().catch(async (e) => { console.error("FATAL", e.stack || e.message); server.kill(); process.exit(1); });