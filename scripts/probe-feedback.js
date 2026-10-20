"use strict";
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const PORT = 4491;
const BASE = `http://localhost:${PORT}`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LOG = path.join(process.env.TEMP || ".", "opencode", "probe-feedback.log");
const L = (m) => { console.log(m); fs.appendFileSync(LOG, m + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.writeFileSync(LOG, "=== probe-feedback ===\n");
  const server = spawn(process.execPath, ["server/server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  await sleep(2500);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-webgl", "--use-gl=swiftshader"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => { errors.push(e.message); L("[pageerror] " + e.message); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#char-select .pick-card").length > 0, { timeout: 20000 });
  L("char cards loaded");

  const readState = () => page.evaluate(() => ({
    toast: document.querySelector("#lobby-toast").textContent,
    toastHidden: document.querySelector("#lobby-toast").classList.contains("hidden"),
    loadout: document.querySelector("#lobby-loadout").innerText.replace(/\n/g, " | "),
    selChar: [...document.querySelectorAll("#char-select .pick-card")].filter((b) => b.classList.contains("sel")).map((b) => b.dataset.char),
    selMap: [...document.querySelectorAll("#map-select .pick-card")].filter((b) => b.classList.contains("sel")).map((b) => b.dataset.map),
    myChar: window.__s().myChar,
    mapId: window.__s().mapId,
    muzzleEl: !!document.querySelector("#muzzle-flash"),
  }));

  await page.evaluate(() => { document.querySelectorAll("#char-select .pick-card")[2].click(); });
  await sleep(120);
  const afterChar = await readState();
  L("afterChar: " + JSON.stringify(afterChar));

  await page.evaluate(() => { document.querySelectorAll("#map-select .pick-card")[1].click(); });
  await sleep(120);
  const afterMap = await readState();
  L("afterMap: " + JSON.stringify(afterMap));

  await sleep(1900);
  const afterHide = await readState();
  L("afterHide toastHidden=" + afterHide.toastHidden);

  // start game & verify render + no errors + theme applied
  await page.$eval("#nickname", (el) => (el.value = "probe"));
  await page.click("#btn-create");
  await page.waitForSelector("#btn-start:not(.hidden)", { timeout: 20000 });
  await page.click("#btn-start");
  await page.waitForFunction(() => window.__s().phase === "combat", { timeout: 40000 });
  await sleep(1500);
  const gameState = await page.evaluate(() => ({
    theme: window.__s().map && window.__s().map.theme ? true : false,
    mapId: window.__s().mapId,
    inGame: window.__s().inGame,
    players: window.__s().players.size,
    canvas: !!document.querySelector("#game-canvas canvas"),
  }));
  L("gameState: " + JSON.stringify(gameState));

  const checks = [];
  checks.push(["char selection registered", afterChar.selChar.length === 1 && afterChar.myChar === afterChar.selChar[0]]);
  checks.push(["char toast shown", !afterChar.toastHidden && afterChar.toast.includes("장착")]);
  checks.push(["map selection registered", afterMap.selMap.length === 1 && afterMap.mapId === afterMap.selMap[0]]);
  checks.push(["map toast shown", !afterMap.toastHidden && afterMap.toast.includes("선택")]);
  checks.push(["loadout bar shows both", afterMap.loadout.includes("현재 설정") && afterMap.loadout.includes("장착") && afterMap.loadout.includes("선택")]);
  checks.push(["toast auto-hides", afterHide.toastHidden === true]);
  checks.push(["muzzle-flash element removed", afterChar.muzzleEl === false]);
  checks.push(["game rendered, canvas present", gameState.canvas && gameState.inGame]);
  checks.push(["map theme present", gameState.theme === true]);
  checks.push(["remote players spawned", gameState.players > 0]);
  checks.push(["no page errors", errors.length === 0]);
  let pass = 0;
  for (const [n, ok] of checks) { L(`${ok ? "PASS" : "FAIL"} ${n}`); if (ok) pass++; }
  L(`RESULT ${pass}/${checks.length}`);
  if (errors.length) L("ERRORS: " + JSON.stringify(errors));

  await browser.close().catch(() => {});
  server.kill();
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { L("FATAL " + (e.stack || e.message)); process.exit(1); });
