"use strict";

/* =========================================================
   scripts/test-mobile-touch.js — 실제 모바일 터치 회귀 테스트
   실행: node scripts/test-mobile-touch.js
   - 테스트 서버에서만 켜지는 /api/test/* 훅으로 궁극기 충전 100을 만든다.
   - 390x844/844x390 터치 뷰포트에서 로비·모달 터치 스크롤과 Q/X 스킬을 검증한다.
========================================================= */

const { spawn } = require("child_process");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const PORT = 3333;
const URL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function touchSwipe(cdp, x, fromY, toY, id = 1) {
  const step = toY < fromY ? -40 : 40;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY, id }] });
  for (let y = fromY + step; step < 0 ? y >= toY : y <= toY; y += step) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id }] });
    await sleep(25);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(350);
}

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
  let page;
  try {
    await waitForServer();
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (e) {
      // 로컬에 Chrome 시스템 라이브러리가 없을 때만 건너뛴다. CI/명시적 게이트에서는 반드시 실행한다.
      if (process.env.CI || process.env.SHOOTER_REQUIRE_MOBILE_TEST === "1") throw e;
      console.warn(`\n[mobile-touch] Chrome 실행 불가로 건너뜀: ${e.message.split("\n")[0]}`);
      return;
    }
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));

    await page.goto(URL, { waitUntil: "networkidle0" });
    await page.waitForSelector("#btn-create", { timeout: 10000 });

    /* 로비가 실제 모바일 레이아웃이고, 터치로 내부 스크롤이 되는지 확인 */
    const lobbyLayout = await page.evaluate(() => {
      const shell = document.querySelector(".lobby-shell");
      const main = document.querySelector(".lobby-main");
      return {
        mobileClass: document.body.classList.contains("mobile-ui"),
        display: getComputedStyle(main).display,
        scrollHeight: shell.scrollHeight,
        clientHeight: shell.clientHeight,
        footer: getComputedStyle(document.querySelector(".lobby-footer")).display,
      };
    });
    assert(lobbyLayout.mobileClass, "모바일 UI 클래스 적용");
    assert.equal(lobbyLayout.display, "flex", "로비 모바일 단일 컬럼 레이아웃");
    assert(lobbyLayout.scrollHeight > lobbyLayout.clientHeight, "로비 콘텐츠가 스크롤 영역보다 큼");
    assert.equal(lobbyLayout.footer, "none", "모바일에서 PC 키 안내 숨김");

    const cdp = await page.createCDPSession();
    await page.evaluate(() => { document.querySelector(".lobby-shell").scrollTop = 0; });
    await touchSwipe(cdp, 200, 720, 320, 1);
    assert((await page.evaluate(() => document.querySelector(".lobby-shell").scrollTop)) > 0, "로비 실제 터치 스크롤");

    /* 가로 모드에서도 PC 2열 레이아웃이 아니라 모바일 단일 컬럼인지 확인 */
    await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
    await page.evaluate(() => { document.querySelector(".lobby-shell").scrollTop = 0; });
    await sleep(150);
    const landscape = await page.evaluate(() => ({
      mobileClass: document.body.classList.contains("mobile-ui"),
      display: getComputedStyle(document.querySelector(".lobby-main")).display,
      scrollHeight: document.querySelector(".lobby-shell").scrollHeight,
      clientHeight: document.querySelector(".lobby-shell").clientHeight,
    }));
    assert(landscape.mobileClass, "가로 모드 모바일 UI 유지");
    assert.equal(landscape.display, "flex", "가로 모드 모바일 단일 컬럼");
    assert(landscape.scrollHeight > landscape.clientHeight, "가로 모드 로비 스크롤 가능");

    /* 가로 로비에서도 실제 터치 스크롤이 동작하는지 확인 */
    await page.evaluate(() => { document.querySelector(".lobby-shell").scrollTop = 0; });
    await touchSwipe(cdp, 420, 300, 80, 2);
    assert((await page.evaluate(() => document.querySelector(".lobby-shell").scrollTop)) > 0, "가로 모드 로비 실제 터치 스크롤");
    console.log("  ✓ 모바일 로비 실제 터치 스크롤/가로 레이아웃");

    await page.type("#nickname", "모바일테스터");
    await page.click("#btn-create");
    await page.waitForSelector("#btn-start", { timeout: 8000 });
    await page.click("#btn-start");
    await page.waitForSelector("#hud:not(.hidden)", { timeout: 15000 });
    await page.waitForSelector("#weapon-select:not(.hidden)", { timeout: 8000 });
    const buyLayout = await page.evaluate(() => {
      const box = document.querySelector(".ws-box");
      return {
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        modal: document.body.classList.contains("modal-open"),
        close: !!document.querySelector("#ws-close"),
      };
    });
    assert(buyLayout.close, "모바일 구매 화면 닫기 버튼 존재");
    assert(buyLayout.modal, "구매 모달 터치 스크롤 상태 활성화");
    assert(buyLayout.scrollHeight > buyLayout.clientHeight, "가로 모드 구매 화면 스크롤 영역");
    await page.evaluate(() => { document.querySelector(".ws-box").scrollTop = 0; });
    await touchSwipe(cdp, 420, 300, 80, 3);
    assert((await page.evaluate(() => document.querySelector(".ws-box").scrollTop)) > 0, "구매 모달 실제 터치 스크롤");
    await page.evaluate(() => document.querySelector("#ws-close").click());
    await page.waitForFunction(() => document.querySelector("#weapon-select").classList.contains("hidden"), { timeout: 2000 });
    console.log("  ✓ 구매 모달 실제 터치 스크롤/닫기");

    /* 설정 모달도 실제 터치로 스크롤되는지 확인 */
    const menuBox = await page.evaluate(() => {
      const r = document.querySelector("#btn-menu").getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.touchscreen.tap(menuBox.x, menuBox.y);
    await page.waitForSelector("#pause:not(.hidden)", { timeout: 3000 });
    const pauseLayout = await page.evaluate(() => {
      const box = document.querySelector(".pause-box");
      return {
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        modal: document.body.classList.contains("modal-open"),
        keysHidden: getComputedStyle(document.querySelector(".setting-row.keys")).display === "none",
      };
    });
    assert(pauseLayout.modal, "설정 모달 터치 스크롤 상태 활성화");
    assert(pauseLayout.scrollHeight > pauseLayout.clientHeight, "가로 모드 설정 화면 스크롤 영역");
    assert(pauseLayout.keysHidden, "모바일 설정에서 PC 키 안내 숨김");
    await page.evaluate(() => { document.querySelector(".pause-box").scrollTop = 0; });
    await touchSwipe(cdp, 420, 300, 80, 4);
    assert((await page.evaluate(() => document.querySelector(".pause-box").scrollTop)) > 0, "설정 모달 실제 터치 스크롤");
    await page.evaluate(() => document.querySelector("#btn-resume").click());
    await page.waitForSelector("#pause.hidden", { timeout: 2000 });
    console.log("  ✓ 설정 모달 실제 터치 스크롤/재개");

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

    console.log("\n[mobile-touch] 5개 테스트 통과");
  } catch (err) {
    console.error("\n[mobile-touch] 테스트 실패:", err.message);
    process.exitCode = 1;
    // CI에서 실패 원인을 바로 볼 수 있도록 화면과 스택을 남긴다.
    const artifactDir = path.join(__dirname, "..", "artifacts");
    try { fs.mkdirSync(artifactDir, { recursive: true }); } catch {}
    try { fs.writeFileSync(path.join(artifactDir, "mobile-touch-failure.log"), String(err.stack || err.message)); } catch {}
    if (page) {
      try { await page.screenshot({ path: path.join(artifactDir, "mobile-touch-failure.png"), fullPage: true }); } catch {}
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
