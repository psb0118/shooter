"use strict";

/* =========================================================
   scripts/test-mobile-touch.js — 실제 모바일 터치 Q/X 회귀 테스트
   실행: node scripts/test-mobile-touch.js
   - 테스트 서버에서만 켜지는 /api/test/* 훅으로 궁극기 충전 100을 만든다.
   - 390x844 터치 뷰포트에서 Q 연막 생성과 X 낙뢰 예약/발동을 검증한다.
========================================================= */

const { spawn } = require("child_process");
const assert = require("assert");
const puppeteer = require("puppeteer");

const PORT = 3333;
const URL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("테스트 서버 시작 타임아웃");
}

async function roomState() {
  const r = await fetch(`${URL}/api/test/state`);
  assert(r.ok, "테스트 상태 조회");
  const rooms = await r.json();
  assert(rooms.length > 0, "방이 존재해야 함");
  return rooms[0];
}

(async () => {
  const server = spawn(process.execPath, ["server/server.js"], {
    env: { ...process.env, PORT: String(PORT), SHOOTER_TEST_HOOKS: "1" },
    stdio: "ignore",
  });
  let browser;
  try {
    await waitForServer();
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (e) {
      // 로컬에 Chrome 시스템 라이브러리가 없을 때만 건너뛴다. CI에서는 반드시 실행한다.
      if (process.env.CI) throw e;
      console.warn(`\n[mobile-touch] Chrome 실행 불가로 건너뜀: ${e.message.split("\n")[0]}`);
      return;
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));

    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.waitForSelector("#btn-create", { timeout: 10000 });
    await page.type("#nickname", "모바일테스터");
    await page.click("#btn-create");
    await page.waitForSelector("#btn-start", { timeout: 8000 });
    await page.click("#btn-start");
    await page.waitForSelector("#hud:not(.hidden)", { timeout: 15000 });
    await sleep(700);
    await page.keyboard.press("p");
    await page.waitForFunction(() => window.__s && window.__s().phase === "combat", { timeout: 25000 });

    const myId = await page.evaluate(() => window.__s().myId);

    /* Q — 실제 터치로 연막 발동 */
    const qBefore = await page.evaluate(() => window.__s().smokes.length);
    const qBox = await page.evaluate(() => {
      const r = document.querySelector("#btn-smoke").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.touchscreen.tap(qBox.x, qBox.y);
    await sleep(700);
    const qAfter = await page.evaluate(() => ({ smokes: window.__s().smokes.length, cls: document.querySelector("#btn-smoke").className }));
    assert(qAfter.smokes > qBefore, `Q 터치로 연막 생성 (${qBefore} → ${qAfter.smokes})`);
    assert(qAfter.cls.includes("cooling"), "Q 쿨다운 오버레이 표시");
    const afterQ = await roomState();
    const myQ = afterQ.players.find(p => p.id === myId);
    assert(myQ && myQ.smokeCd > 0, `서버 연막 쿨다운 (${myQ ? myQ.smokeCd.toFixed(1) : "?"}s)`);
    console.log("  ✓ Q 실제 터치 → 연막 생성/쿨다운");

    /* X — 테스트 훅으로 실제 서버 플레이어를 100 충전한 뒤 터치 발동 */
    const cr = await fetch(`${URL}/api/test/charge-ult`, { method: "POST" });
    assert(cr.ok, "테스트 충전 훅");
    await page.waitForFunction(() => window.__s().ultCharge >= 100, { timeout: 5000 });
    assert((await page.evaluate(() => document.querySelector("#btn-ult").className)).includes("ready"), "X 버튼 ready 표시");
    const xBox = await page.evaluate(() => {
      const r = document.querySelector("#btn-ult").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.touchscreen.tap(xBox.x, xBox.y);
    await sleep(450);
    const mid = await roomState();
    const myMid = mid.players.find(p => p.id === myId);
    assert(myMid && myMid.ultCharge === 0, "X 터치 후 서버 충전 소모");
    assert(mid.pendingUlts.length > 0, "X 터치 후 낙뢰 예약");
    await sleep(1800);
    const end = await roomState();
    assert.equal(end.pendingUlts.length, 0, "낙뢰 예약 처리 완료");
    await page.waitForFunction(() => window.__s().ultCharge === 0, { timeout: 5000 });
    assert.deepEqual(errors, [], "페이지 오류 없음");
    console.log("  ✓ X 실제 터치 → 서버 충전 100/낙뢰 예약/처리 완료");

    console.log("\n[mobile-touch] 2개 테스트 통과");
  } catch (err) {
    console.error("\n[mobile-touch] 테스트 실패:", err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
