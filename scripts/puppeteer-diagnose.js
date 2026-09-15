const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const http = require("http");

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE || `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LOCAL = BASE.startsWith("http://localhost") || BASE.startsWith("http://127.0.0.1");

let server = null;
if (LOCAL) {
  server = spawn(process.execPath, ["server/server.js"], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function waitUp(ms) {
  const tryOne = () =>
    new Promise((resolve) => {
      const mod = BASE.startsWith("https") ? require("https") : require("http");
      const req = mod.get(BASE, (res) => {
        res.resume();
        res.on("end", () => resolve(true));
      });
      req.on("error", () => resolve(false));
    });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      if (await tryOne()) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        resolve(false);
      }
    }, 250);
  });
}

// 새 클라이언트 상태 접근자 헬퍼
function stDump() {
  const s = window.__s();
  return JSON.stringify({
    inGame: s.inGame, phase: s.phase, round: s.round, myTeam: s.myTeam, myHP: s.myHP, myWeapon: s.myWeapon, myMoney: s.myMoney, alive: s.alive,
    x: +s.x.toFixed(2), z: +s.z.toFixed(2), yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3),
    spike: { planted: s.spike && s.spike.planted, carrier: s.spike && s.spike.carrierId, pos: s.spike && s.spike.placed ? (s.spike.x + "," + s.spike.z) : null },
    keys: { ...s.keys },
  });
}

(async () => {
  if (!(await waitUp(10000))) {
    console.log("[FAIL] server did not come up");
    if (server) server.kill();
    process.exit(1);
  }
  console.log("[SERVER] up at " + BASE);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server", "--disable-features=BlockInsecurePrivateNetworkRequests", "--enable-webgl", "--use-gl=swiftshader"],
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const logs = [];
  page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || "").split("\n").slice(0, 8).join("\n")}`));
  page.on("response", (r) => {
    if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
  });

  let fails = 0;
  const check = (label, ok, extra) => {
    console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? "  " + extra : ""}`);
    if (!ok) fails++;
  };

  try {
    await page.goto(BASE, { timeout: 30000, waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__s !== undefined, { timeout: 15000 });
    console.log("[PAGE] loaded, __s hook available");

    await page.waitForSelector("#nickname", { visible: true, timeout: 10000 });
    await page.$eval("#nickname", (el) => (el.value = "진단용"));
    await page.click("#btn-create");
    await page.waitForSelector("#btn-start:not(.hidden)", { visible: true, timeout: 15000 });
    await page.click("#btn-start");

    await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 15000 });
    await page.waitForSelector("#weapon-select:not(.hidden)", { visible: true, timeout: 8000 });
    console.log("[GAME] HUD + buy overlay auto-open OK");

    const st0 = JSON.parse(await page.evaluate(stDump));
    check("구매 오버레이/초기 P1 상태", st0.phase === "buy" && st0.myMoney === 800 && st0.myHP === 150, `phase=${st0.phase} money=${st0.myMoney} hp=${st0.myHP}`);

    const ws = await page.evaluate(() => ({
      weapons: Object.keys(window.__s().weapons || {}),
      cards: [...document.querySelectorAll(".ws-card")].length,
      poor: document.querySelectorAll(".ws-card.poor").length,
      money: document.getElementById("ws-money").textContent,
    }));
    check("무기 그리드 5종/가격표시", ws.weapons.length === 5 && ws.cards === 5 && ws.money === "800" && ws.poor >= 4,
      `weapons=${ws.weapons.join(",")} cards=${ws.cards} poor=${ws.poor} money=${ws.money}`);

    // 권총(무료) 구매 — 상태 그대로 폐쇄 + 리락 시도
    await page.click('.ws-card[data-w="pistol"]');
    await new Promise((r) => setTimeout(r, 600));
    const afterPick = await page.evaluate(() => {
      const s = window.__s();
      return { myWeapon: s.myWeapon, closed: document.getElementById("weapon-select").classList.contains("hidden"), money: s.myMoney };
    });
    check("무료 권총 구매 무결성", afterPick.myWeapon === "pistol" && afterPick.closed && afterPick.money === 800, JSON.stringify(afterPick));

    // P 키 토글 (닫혀있음 → 열림 → 닫힘)
    const p0 = await page.evaluate(() => document.getElementById("weapon-select").classList.contains("hidden"));
    await page.keyboard.press("KeyP");
    await new Promise((r) => setTimeout(r, 400));
    const pOpen = await page.evaluate(() => !document.getElementById("weapon-select").classList.contains("hidden"));
    await page.keyboard.press("KeyP");
    await new Promise((r) => setTimeout(r, 400));
    const pClose = await page.evaluate(() => document.getElementById("weapon-select").classList.contains("hidden"));
    check("P 키 구매 토글", p0 && pOpen && pClose, `closed=${p0} open=${pOpen} close=${pClose}`);

    // combat 전환 대기 후 P 무효(구매 단계 게이트)
    await page.waitForFunction(() => { const s = window.__s(); return s.phase === "combat" && s.round === 1; }, { timeout: 25000 });
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press("KeyP");
    await new Promise((r) => setTimeout(r, 400));
    const pCombat = await page.evaluate(() => document.getElementById("weapon-select").classList.contains("hidden"));
    check("combat에서 구매차단(P 무효)", pCombat);

    // 이동 — 예측/서버 에코 (포인터 락과 무관하게 키입력으로 서버 이동)
    const start = JSON.parse(await page.evaluate(stDump));
    await page.keyboard.down("KeyW");
    await new Promise((r) => setTimeout(r, 1500));
    await page.keyboard.up("KeyW");
    await new Promise((r) => setTimeout(r, 500));
    const end = JSON.parse(await page.evaluate(stDump));
    const dist = Math.hypot(end.x - start.x, end.z - start.z);
    check("W 이동(서버 에코)", dist > 1.0, `dist=${dist.toFixed(2)} start=(${start.x},${start.z}) end=(${end.x},${end.z})`);

    // 스트레이프 방향: yaw=π(남쪽) 기준 A=-X / D=+X (봇이 막으면 재시도)
    async function pressMove(key) {
      let best = 0;
      for (let i = 0; i < 4; i++) {
        const x0 = JSON.parse(await page.evaluate(stDump)).x;
        await page.keyboard.down(key);
        await new Promise((r) => setTimeout(r, 800));
        await page.keyboard.up(key);
        await new Promise((r) => setTimeout(r, 350));
        const dx = JSON.parse(await page.evaluate(stDump)).x - x0;
        best = Math.abs(dx) > Math.abs(best) ? dx : best;
        if (Math.abs(best) > 0.3) break;
      }
      return best;
    }
    const dxA = await pressMove("KeyA");
    const dxD = await pressMove("KeyD");
    check("A/D 스트레이프 방향", dxA < -0.3 && dxD > 0.3, `dA=${dxA.toFixed(2)} dD=${dxD.toFixed(2)}`);

    // 발사 — 포인터 락 상태에서만 유효 (headless에선 선택 적용)
    if (await page.evaluate(() => document.pointerLockElement !== null)) {
      const ammo0 = await page.evaluate(() => window.__s().myAmmo);
      await page.mouse.down({ button: "left" });
      await new Promise((r) => setTimeout(r, 1200));
      await page.mouse.up({ button: "left" });
      const ammo1 = await page.evaluate(() => window.__s().myAmmo);
      check("발사 탄약 감소", ammo1 < ammo0, `ammo ${ammo0}->${ammo1}`);
    } else {
      console.log("[FIRE] pointer lock 비활성 — 사격 확인 생략");
    }

    // ADS — 포인터 락 되면 확대 확인 (실패해도 치명 X)
    const locked = await page.evaluate(() => document.pointerLockElement !== null);
    if (locked) {
      await page.mouse.down({ button: "right" });
      await new Promise((r) => setTimeout(r, 300));
      const fov = await page.evaluate(() => +window.__s.camera.fov.toFixed(1));
      await page.mouse.up({ button: "right" });
      check("ADS 확대", fov < 60, `fov=${fov}`);
      await page.mouse.move(700, 500, { steps: 8 });
      await page.mouse.move(900, 500, { steps: 8 });
    } else {
      console.log("[ADS] pointer lock 비활성 — 확인 생략");
    }

    // 라운드 2 진입까지 대기 (HUD 라운드/머니 갱신 확인)
    await page.waitForFunction(() => window.__s().round >= 2 && window.__s().phase === "buy", { timeout: 120000 });
    const r2 = JSON.parse(await page.evaluate(stDump));
    check("라운드 2 자동 구매창 재오픈", r2.phase === "buy" && r2.myHP === 150, `round=${r2.round} hp=${r2.myHP} money=${r2.myMoney}`);

    console.log("[SHOT] saving...");
    await page.screenshot({ path: "scripts/diagnose-shot.png" });

    console.log(`\n======= 진단 결과: ${fails === 0 ? "ALL PASS" : fails + " FAIL" } =======`);
  } catch (err) {
    console.log("[FAIL]", err.stack || err.message);
    fails++;
  }

  console.log("==================== BROWSER LOGS ====================");
  logs.forEach((l) => console.log(l));
  if (logs.length === 0) console.log("(no console/page errors)");
  console.log(`EXIT_CODE=${fails === 0 ? 0 : 1}`);

  await browser.close();
  if (server) server.kill();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error("DIAGNOSE FATAL", e);
  if (server) server.kill();
  process.exit(1);
});