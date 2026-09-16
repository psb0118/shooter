"use strict";
const puppeteer = require("puppeteer");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const r = await page.evaluate(() => ({
    ontouchstart: "ontouchstart" in window,
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: window.matchMedia ? matchMedia("(pointer: coarse)").matches : null,
    fine: window.matchMedia ? matchMedia("(pointer: fine)").matches : null,
    ua: navigator.userAgent,
  }));
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})();