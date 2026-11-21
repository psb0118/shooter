"use strict";

/* Q/X 모바일 터치 버튼이 DOM과 터치 디스패처에 연결되어 있는지 빠르게 검사하는 회귀 테스트.
   실제 터치 발동은 scripts/test-mobile-touch.js에서 Puppeteer로 검증한다. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "client/index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "client/main.js"), "utf8");

assert.match(html, /id="btn-smoke"[^>]*aria-label="연막 \(Q\)"/, "연막 터치 버튼 마크업");
assert.match(html, /id="btn-ult"[^>]*aria-label="궁극기 \(X\)"/, "궁극기 터치 버튼 마크업");
assert.match(main, /id === "btn-smoke"\) useSmoke\(\)/, "btn-smoke → useSmoke 연결");
assert.match(main, /id === "btn-ult"\) useUlt\(\)/, "btn-ult → useUlt 연결");
assert.match(main, /function useSmoke\(\)[\s\S]*game:skill[\s\S]*smoke/, "연막 스킬 전송 경로");
assert.match(main, /function useUlt\(\)[\s\S]*game:skill[\s\S]*ult/, "궁극기 스킬 전송 경로");

console.log("  ✓ Q/X 터치 버튼 DOM·디스패처 연결");
console.log("\n[touch-wiring] 1개 테스트 통과");
