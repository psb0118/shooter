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

(async () => {
  if (!(await waitUp(10000))) {
    console.log("[FAIL] server did not come up");
    server.kill();
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
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || "").split("\n").slice(0, 6).join("\n")}`));
  page.on("response", (r) => {
    if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
  });

  try {
    await page.goto(BASE, { timeout: 30000, waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__s !== undefined, { timeout: 15000 });
    console.log("[PAGE] loaded, __s hook available");

    await page.waitForSelector("#nickname", { visible: true, timeout: 10000 });
    await page.$eval("#nickname", (el) => (el.value = "진단용"));
    await page.click("#btn-create");
    await page.waitForSelector("#btn-start:not(.hidden)", { visible: true, timeout: 15000 });
    console.log("[LOBBY] room created, start button visible");
    await page.click("#btn-start");

    await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 15000 });
    console.log("[GAME] HUD visible => in game");
    await new Promise((r) => setTimeout(r, 1500));

    const dump = await page.evaluate(() => {
      const s = window.__s;
      return {
        inGame: s.inGame,
        myAlive: s.myAlive,
        myWeapon: s.myWeapon,
        pos: { x: +s.myPred.x.toFixed(2), z: +s.myPred.z.toFixed(2) },
        yaw: +s.myPred.yaw.toFixed(3),
        pitch: +s.myPred.pitch.toFixed(3),
        keys: { ...s.keys },
      };
    });
    console.log("[INIT]", JSON.stringify(dump));

    const lockBefore = await page.evaluate(() => document.pointerLockElement !== null);
    console.log("[POINTERLOCK before click]", lockBefore);

    await page.mouse.click(640, 400, { button: "left" });
    await new Promise((r) => setTimeout(r, 800));
    const lockAfter = await page.evaluate(() => document.pointerLockElement !== null);
    console.log("[POINTERLOCK after click]", lockAfter);

    const start = await page.evaluate(() => ({ x: window.__s.myPred.x, z: window.__s.myPred.z, yaw: window.__s.myPred.yaw }));
    await page.keyboard.down("KeyW");
    await new Promise((r) => setTimeout(r, 1200));
    await page.keyboard.up("KeyW");
    await new Promise((r) => setTimeout(r, 400));
    const end = await page.evaluate(() => ({ x: window.__s.myPred.x, z: window.__s.myPred.z, yaw: window.__s.myPred.yaw, keys: { ...window.__s.keys } }));
    console.log("[W-MOVE] start", JSON.stringify(start));
    console.log("[W-MOVE] end", JSON.stringify(end));

    const dist = +Math.hypot(end.x - start.x, end.z - start.z).toFixed(3);
    console.log("[W-MOVE] dist=" + dist + (dist > 1 ? " => moved OK" : " => NOT moving"));

    const y0 = await page.evaluate(() => window.__s.myPred.yaw);
    await page.keyboard.down("ArrowRight");
    await new Promise((r) => setTimeout(r, 400));
    await page.keyboard.up("ArrowRight");
    const y1 = await page.evaluate(() => window.__s.myPred.yaw);
    console.log("[LOOK arrowR] yaw", +y0.toFixed(3), "->", +y1.toFixed(3), "delta", +(y1 - y0).toFixed(3));

    console.log("[TITLE]", await page.$eval("title", (t) => t.textContent));

    // 포인터 락 활성 상태에서 마우스 움직임 = 시야 회전 확인
    if (await page.evaluate(() => document.pointerLockElement !== null)) {
      const y0 = await page.evaluate(() => window.__s.myPred.yaw);
      await page.mouse.move(700, 500, { steps: 8 });
      await page.mouse.move(900, 500, { steps: 8 });
      const y1 = await page.evaluate(() => window.__s.myPred.yaw);
      console.log("[LOOK mouse-lock] yaw", +y0.toFixed(3), "->", +y1.toFixed(3), "delta", +(y1 - y0).toFixed(3), (Math.abs(y1 - y0) > 0.001 ? "=> mouse look OK" : "=> mouse look X"));
    }

    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: "scripts/diagnose-shot.png" });
    console.log("[SHOT] saved scripts/diagnose-shot.png");
  } catch (err) {
    console.log("[FAIL]", err.stack || err.message);
  }

  console.log("==================== BROWSER LOGS ====================");
  logs.forEach((l) => console.log(l));
  if (logs.length === 0) console.log("(no console/page errors)");

  await browser.close();
  if (server) server.kill();
  process.exit(0);
})().catch((e) => {
  console.error("DIAGNOSE FATAL", e);
  if (server) server.kill();
  process.exit(1);
});